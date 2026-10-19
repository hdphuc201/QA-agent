#!/usr/bin/env node
// Vertical slice (roadmap P6): discover (live, Playwright MCP) → plan → generate (+validate) → run,
// on a fresh copy of examples/sample-app started from its seed data. No AI is involved.
// Usage: node scripts/smoke/vertical-slice.mjs [--bug skip-approve-rbac] [--out evidence/P6/slice-x] [--keep]
// Exit code: 0 when every stage succeeded and every run phase passed; 1 otherwise.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startSampleApp } from '../../examples/sample-app/server.mjs';
import { makeTextRedactor } from './redact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({
  options: { bug: { type: 'string' }, out: { type: 'string' }, keep: { type: 'boolean' } },
});
// The demo passwords below are passed to child processes only; they must never reach evidence.
const redact = makeTextRedactor({ secrets: ['alice-demo', 'bob-demo', 'victor-demo'] });
const say = (/** @type {string} */ s) => process.stdout.write(`${s}\n`);

// 1. Fresh target project (no generated outputs), own node_modules via a junction.
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'qa slice '));
const skip = /[\\/](e2e|qa-artifacts|node_modules)([\\/]|$)|[\\/]\.qa-agent[\\/](?!config\.json$)/;
fs.cpSync(path.join(root, 'examples/sample-app'), project, {
  recursive: true,
  filter: (src) => !skip.test(path.sep + path.relative(root, src)),
});
fs.symlinkSync(path.join(root, 'node_modules'), path.join(project, 'node_modules'), 'junction');
fs.writeFileSync(path.join(project, 'package.json'), '{"name":"sample-target","private":true}\n');

// 2. Fresh app from seed data, on a free port; the config follows that origin.
const app = await startSampleApp({
  env: { SAMPLE_APP_TEST_MODE: '1', ...(values.bug ? { SAMPLE_APP_BUG: values.bug } : {}) },
});
const cfgFile = path.join(project, '.qa-agent/config.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
cfg.baseURL = `${app.url}/`;
cfg.allowedOrigins = [app.url];
fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
say(
  `sample app ${app.url}${values.bug ? ` with intentional defect "${values.bug}"` : ''}; project ${redact(project)}`,
);

const env = {
  ...process.env,
  FORCE_COLOR: '0',
  QA_AGENT_BROWSER_CHANNEL: process.env.QA_AGENT_BROWSER_CHANNEL ?? 'chrome',
  QA_AGENT_ACCOUNT_DEMO_REQUESTER_USERNAME: 'alice',
  QA_AGENT_ACCOUNT_DEMO_REQUESTER_PASSWORD: 'alice-demo',
  QA_AGENT_ACCOUNT_DEMO_APPROVER_USERNAME: 'bob',
  QA_AGENT_ACCOUNT_DEMO_APPROVER_PASSWORD: 'bob-demo',
  QA_AGENT_ACCOUNT_DEMO_VIEWER_USERNAME: 'victor',
  QA_AGENT_ACCOUNT_DEMO_VIEWER_PASSWORD: 'victor-demo',
};

/** @param {string[]} args */
function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        path.join(root, 'src/cli.ts'),
        ...args,
        '--project',
        project,
      ],
      { cwd: project, env },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out: redact(out) }));
  });
}

// 3. The pipeline.
const stages = [];
for (const args of [['discover'], ['plan'], ['generate', '--validate'], ['run'], ['report']]) {
  const t0 = Date.now();
  const r = await cli(args);
  stages.push({ stage: args.join(' '), exitCode: r.code, durationMs: Date.now() - t0, log: r.out });
  say(`== ${args.join(' ')}: exit=${r.code}`);
  // run/report exit 1 when tests fail: that is a result, not a broken pipeline.
  if (args[0] !== 'run' && args[0] !== 'report' && r.code !== 0) {
    say(r.out);
    break;
  }
}
await app.close();

// 4. Results per case from the run's JSON reports.
const runsDir = path.join(project, 'qa-artifacts/runs');
const runId = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).sort().at(-1) : undefined;
const runDir = runId ? path.join(runsDir, runId) : null;
/** @type {{ id: string, status: string, phase: string, error?: string }[]} */
const cases = [];
if (runDir) {
  for (const f of fs.readdirSync(runDir).filter((x) => /^results-.*\.json$/.test(x))) {
    const report = JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8'));
    /** @param {any} s */
    const walk = (s) => {
      for (const sp of s.specs ?? []) {
        for (const t of sp.tests) {
          const last = t.results.at(-1);
          const error =
            last?.error?.message?.split('\n').find((/** @type {string} */ l) => l.trim()) ??
            undefined;
          cases.push({
            id: sp.title.split(' ')[0],
            status: last?.status ?? 'notRun',
            phase: f.slice(8, -5),
            ...(error ? { error: redact(error).slice(0, 300) } : {}),
          });
        }
      }
      for (const c of s.suites ?? []) walk(c);
    };
    report.suites.forEach(walk);
  }
}
cases.sort((a, b) => a.id.localeCompare(b.id));
const failed = cases.filter((c) => c.status !== 'passed');
const summary = {
  bug: values.bug ?? null,
  runId: runId ?? null,
  stages: stages.map((s) => ({ stage: s.stage, exitCode: s.exitCode, durationMs: s.durationMs })),
  cases: { total: cases.length, passed: cases.length - failed.length, notPassed: failed.length },
  failed,
  ok: stages.every((s) => s.exitCode === 0) && failed.length === 0,
};

// 5. Evidence: stage logs, discovery/plan/generated outputs, run record (no traces/HTML: may hold data).
if (values.out) {
  const out = path.resolve(root, values.out);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const s of stages)
    fs.writeFileSync(
      path.join(out, `stage-${s.stage.split(' ')[0]}.log`),
      `$ qa-agent ${s.stage}\n${s.log}\n# exit=${s.exitCode}\n`,
    );
  const copy = (/** @type {string} */ from, /** @type {string} */ to) => {
    if (!fs.existsSync(from)) return;
    fs.cpSync(from, path.join(out, to), {
      recursive: true,
      filter: (src) =>
        // Per-phase dirs are test-results-<phase>/ and html-<phase>/: exclude every variant.
        !/[\\/](test-results[^\\/]*|html[^\\/]*|trace|auth)([\\/]|$)|\.zip$|\.webm$|\.png$/.test(
          src,
        ),
    });
  };
  copy(path.join(project, '.qa-agent/discovery'), 'discovery');
  copy(path.join(project, '.qa-agent/plan'), 'plan');
  copy(path.join(project, 'e2e/generated'), 'generated');
  if (runDir) copy(runDir, `run`);
  for (const file of fs.readdirSync(out, { recursive: true })) {
    const abs = path.join(out, String(file));
    if (fs.statSync(abs).isFile() && /\.(json|md|ts|log|csv)$/.test(abs))
      fs.writeFileSync(abs, redact(fs.readFileSync(abs, 'utf8')));
  }
  fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}
if (!values.keep) fs.rmSync(project, { recursive: true, force: true });
say(
  JSON.stringify(
    { ...summary, failed: summary.failed.map((f) => `${f.id} ${f.status}: ${f.error ?? ''}`) },
    null,
    2,
  ),
);
process.exitCode = summary.ok ? 0 : 1;

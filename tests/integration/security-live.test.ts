// P8 gate (live): policies enforced at the execution layer and no credential leak via artifacts.
// Session cache OFF, so every test types passwords into the login form; the defect makes tests
// fail, so Playwright keeps traces. Skipped only when QA_AGENT_SKIP_LIVE=1.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startSampleApp } from '../../examples/sample-app/server.mjs';
import { parseProjectConfig, type ProjectConfig } from '../../src/config/project-config.schema.ts';
import { runDiscover } from '../../src/discovery/discover.ts';
import { readZip } from '../../src/evidence/zip.ts';
import { runGenerate } from '../../src/generator/generate.ts';
import { resolveFromProject } from '../../src/generator/validate.ts';
import { runSuite, type RunRecord } from '../../src/orchestrator/run.ts';
import { runPlan } from '../../src/planning/plan-stage.ts';
import type { TestPlan } from '../../src/planning/schema.ts';
import { copySampleApp, repoRoot } from '../helpers/sample-app.ts';

const skip = process.env.QA_AGENT_SKIP_LIVE === '1';
const PASSWORDS = ['alice-demo', 'bob-demo', 'victor-demo'];
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

const PROBE_SPEC = `import { test, expect } from './qa-agent.fixtures';

test('G1 the runtime aborts every request to a non-allowlisted origin', async ({ actors }) => {
  const page = await actors.page('anonymous');
  await page.goto('/login');
  const outcome = await page.evaluate(() => fetch('https://example.com/x').then(() => 'loaded', () => 'blocked'));
  expect(outcome).toBe('blocked');
  // Last: a blocked navigation leaves the page on the browser's error page.
  await expect(page.goto('https://example.com/')).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED/);
  expect(actors.blockedRequests.some((u) => u.startsWith('https://example.com/'))).toBe(true);
});
`;

let app: { url: string; close: () => Promise<void> };
let root = '';
let config: ProjectConfig;
let plan: TestPlan;

before(async () => {
  if (skip) return;
  app = await startSampleApp({
    env: { SAMPLE_APP_TEST_MODE: '1', SAMPLE_APP_BUG: 'skip-approve-rbac' },
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa security live '));
  copySampleApp(root);
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"sample-target","private":true}\n');
  const cfgFile = path.join(root, '.qa-agent/config.json');
  const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  raw.baseURL = `${app.url}/`;
  raw.allowedOrigins = [app.url];
  raw.session = { cache: false };
  fs.writeFileSync(cfgFile, JSON.stringify(raw, null, 2));
  config = parseProjectConfig(raw, 'cfg');
  await runDiscover({ projectRoot: root, config, tools: null });
  plan = runPlan({ projectRoot: root, config }).plan;
  await runGenerate({
    projectRoot: root,
    config,
    plan,
    runtimeFile: path.join(repoRoot, 'src/generator/runtime/qa-agent.fixtures.ts'),
  });
});
after(async () => {
  if (skip) return;
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** All text inside a file, opening zips (and zips inside zips / base64 in HTML). */
function contents(file: string): string {
  const buf = fs.readFileSync(file);
  const unzip = (b: Buffer): string =>
    readZip(b)
      .map((e) => (e.name.endsWith('.zip') ? unzip(e.data) : e.data.toString('utf8')))
      .join('\n');
  if (file.endsWith('.zip')) return unzip(buf);
  const text = buf.toString('utf8');
  const embedded = [...text.matchAll(/data:application\/zip;base64,([A-Za-z0-9+/=]+)/g)].map((m) =>
    unzip(Buffer.from(m[1] ?? '', 'base64')),
  );
  return [text, ...embedded].join('\n');
}
const walk = (d: string): string[] =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

describe('P8 gate: security at the execution layer', { skip }, () => {
  test('no credential value survives in traces, HTML/JSON reports or other run artifacts', async () => {
    const record: RunRecord = await runSuite({
      projectRoot: root,
      config,
      plan,
      env,
      out: () => undefined,
    });
    assert.equal(record.exitCode, 1, 'the defect makes the run fail (so traces are kept)');
    const runDir = path.join(root, 'qa-artifacts/runs', record.runId);
    const files = walk(runDir).filter((f) => /\.(zip|html|json|md|trace|network|txt)$/.test(f));
    assert.ok(
      files.some((f) => f.endsWith('trace.zip')),
      'traces were recorded',
    );
    const scrubbed = record.phases.reduce((n, p) => n + (p.scrub?.replacements ?? 0), 0);
    assert.ok(scrubbed > 0, 'typed passwords were found in the artifacts and replaced');
    for (const f of files) {
      const text = contents(f);
      for (const pw of PASSWORDS)
        assert.ok(!text.includes(pw), `${path.relative(runDir, f)} still contains a password`);
    }
    // The traces are still usable: they keep the recorded fill actions, with masked values.
    const trace = files.find((f) => f.endsWith('trace.zip')) ?? '';
    assert.match(contents(trace), /"method":"fill"/);
  });

  test('generated tests cannot reach other origins (navigation and fetch are aborted)', async () => {
    fs.writeFileSync(path.join(root, 'e2e/generated/qa-guard-probe.spec.ts'), PROBE_SPEC);
    const cli = resolveFromProject(root, '@playwright/test/cli') ?? '';
    const results = path.join(root, 'qa-artifacts/guard-probe.json');
    const child = spawn(
      process.execPath,
      [
        cli,
        'test',
        '-c',
        path.join(root, 'e2e/generated/playwright.qa-agent.config.ts'),
        '--reporter=json',
        'qa-guard-probe',
      ],
      {
        cwd: root,
        env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: results },
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    const code = await new Promise((r) => child.on('close', r));
    const text = fs.readFileSync(results, 'utf8');
    const report = JSON.parse(text) as { stats: { expected: number; unexpected: number } };
    const errors = [...text.matchAll(/"message": ?"((?:[^"\\]|\\.){0,400})/g)].map((m) => m[1]);
    assert.equal(code, 0, errors.join('\n') || JSON.stringify(report.stats));
    assert.equal(report.stats.expected, 1);
  });
});

#!/usr/bin/env node
// In-Claude MVP smoke: `/qa-agent:full-test --offline` on a fresh sample-app copy whose app runs
// with the intentional defect, so the report and the failure-analyzer agent have real work.
// Must run in a normal terminal (Claude Code refuses nested sessions). Uses the Claude API.
// Usage: node scripts/smoke/claude-fulltest-smoke.mjs [--out evidence/P7] [--budget 3]

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startSampleApp } from '../../examples/sample-app/server.mjs';
import { makeTextRedactor, redactTranscript } from './redact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: { out: { type: 'string' }, budget: { type: 'string' } } });
const outDir = path.resolve(root, values.out ?? 'evidence/P7');
fs.mkdirSync(outDir, { recursive: true });
if (process.env.CLAUDECODE) {
  console.error(
    'Refusing to run inside a Claude Code session. Run this script in a normal terminal.',
  );
  process.exit(2);
}
// The demo passwords below are passed to child processes only; they must never reach evidence.
const redact = makeTextRedactor({ secrets: ['alice-demo', 'bob-demo', 'victor-demo'] });
/** @type {Record<string, unknown>} */
const checks = {
  startedAt: new Date().toISOString(),
  claudeVersion: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim(),
};

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'qa claude full test '));
const skip = /[\\/](e2e|qa-artifacts|node_modules)([\\/]|$)|[\\/]\.qa-agent[\\/](?!config\.json$)/;
fs.cpSync(path.join(root, 'examples/sample-app'), project, {
  recursive: true,
  filter: (src) => !skip.test(path.sep + path.relative(root, src)),
});
fs.symlinkSync(path.join(root, 'node_modules'), path.join(project, 'node_modules'), 'junction');
fs.writeFileSync(path.join(project, 'package.json'), '{"name":"sample-target","private":true}\n');
const app = await startSampleApp({
  env: { SAMPLE_APP_TEST_MODE: '1', SAMPLE_APP_BUG: 'skip-approve-rbac' },
});
const cfgFile = path.join(project, '.qa-agent/config.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
cfg.baseURL = `${app.url}/`;
cfg.allowedOrigins = [app.url];
fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
console.log(`sample app ${app.url} (intentional defect on); project ${redact(project)}`);

const env = {
  ...process.env,
  QA_AGENT_BROWSER_CHANNEL: process.env.QA_AGENT_BROWSER_CHANNEL ?? 'chrome',
  QA_AGENT_ACCOUNT_DEMO_REQUESTER_USERNAME: 'alice',
  QA_AGENT_ACCOUNT_DEMO_REQUESTER_PASSWORD: 'alice-demo',
  QA_AGENT_ACCOUNT_DEMO_APPROVER_USERNAME: 'bob',
  QA_AGENT_ACCOUNT_DEMO_APPROVER_PASSWORD: 'bob-demo',
  QA_AGENT_ACCOUNT_DEMO_VIEWER_USERNAME: 'victor',
  QA_AGENT_ACCOUNT_DEMO_VIEWER_PASSWORD: 'victor-demo',
};
const args = [
  '-p',
  '--plugin-dir',
  root,
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--max-budget-usd',
  values.budget ?? '3',
  '--allowedTools',
  'Bash(node:*)',
  'Read',
  'Write',
  'Glob',
  'Grep',
  'Task',
  'Agent',
  '--',
  '/qa-agent:full-test --offline',
];
const child = spawn('claude', args, {
  cwd: project,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => (stdout += d));
child.stderr.on('data', (d) => (stderr += d));
const timer = setTimeout(() => child.kill(), 20 * 60_000);
checks.claudeExit = await new Promise((resolve) => child.on('close', resolve));
clearTimeout(timer);
await app.close();
fs.writeFileSync(
  path.join(outDir, 'claude-fulltest-smoke.jsonl'),
  redactTranscript(stdout, redact),
);
if (stderr.trim()) console.log(`stderr: ${redact(stderr.trim()).slice(-2000)}`);

/** @type {any[]} */
const events = stdout
  .split('\n')
  .filter((l) => l.trim().startsWith('{'))
  .map((l) => JSON.parse(l));
const uses = events
  .filter((e) => e.type === 'assistant')
  .flatMap((e) => e.message?.content ?? [])
  .filter((c) => c.type === 'tool_use');
const bash = uses.filter((u) => u.name === 'Bash').map((u) => String(u.input?.command ?? ''));
const agents = uses
  .filter((u) => u.name === 'Task' || u.name === 'Agent')
  .map((u) => String(u.input?.subagent_type ?? ''));
const result = events.find((e) => e.type === 'result');
const state = path.join(project, '.qa-agent/full-test-state.json');
const runId = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')).runId : null;
const reportFile = runId
  ? path.join(project, 'qa-artifacts/runs', runId, 'report/results.json')
  : '';
const report =
  reportFile && fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
const aiFile = runId ? path.join(project, 'qa-artifacts/runs', runId, 'ai-analysis.json') : '';

Object.assign(checks, {
  init: (() => {
    const init = events.find((e) => e.subtype === 'init') ?? {};
    return {
      pluginCommands: (init.slash_commands ?? []).filter((/** @type {string} */ s) =>
        s.startsWith('qa-agent'),
      ),
      agents: init.agents,
    };
  })(),
  engineCommands: bash.filter((c) => c.includes('src/cli.ts')).map(redact),
  subagents: agents,
  runId,
  reportCounts: report?.coverage?.counts ?? null,
  analyses: (report?.analyses ?? []).map(
    (/** @type {any} */ a) => `${a.caseId} ${a.classification} ${a.confidence} ${a.source}`,
  ),
  aiNotes: report?.aiNotes ?? null,
  aiAnalysisFile: Boolean(aiFile && fs.existsSync(aiFile)),
  costUsd: result?.total_cost_usd,
  finalText: redact(String(result?.result ?? '')).slice(-3000),
});
const required = {
  claudeExited0: checks.claudeExit === 0,
  fullTestViaEngine: bash.some((c) => c.includes('src/cli.ts') && c.includes('full-test')),
  pipelineCompleted: Boolean(report),
  defectFound: report?.coverage?.counts?.failed === 2,
  failureAnalyzerUsed: agents.some((a) => a.includes('failure-analyzer')),
  aiAnalysisMerged: (report?.analyses ?? []).some((/** @type {any} */ a) => a.source === 'ai'),
  skillMarker: String(result?.result ?? '').includes('QA-AGENT-SKILL: full-test'),
};
checks.required = required;
checks.result = Object.values(required).every(Boolean) ? 'PASS' : 'FAIL';
fs.writeFileSync(
  path.join(outDir, 'claude-fulltest-smoke.json'),
  `${redact(JSON.stringify(checks, null, 2))}\n`,
);
for (const f of ['summary.md', 'report.html', 'results.json']) {
  const src = runId ? path.join(project, 'qa-artifacts/runs', runId, 'report', f) : '';
  if (src && fs.existsSync(src))
    fs.writeFileSync(
      path.join(outDir, `claude-fulltest-report-${f}`),
      redact(fs.readFileSync(src, 'utf8')),
    );
}
if (aiFile && fs.existsSync(aiFile))
  fs.writeFileSync(
    path.join(outDir, 'claude-fulltest-ai-analysis.json'),
    redact(fs.readFileSync(aiFile, 'utf8')),
  );
try {
  fs.rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
} catch {
  console.log(`warning: could not remove ${redact(project)}`);
}
console.log(`RESULT ${checks.result} ${JSON.stringify(required)}`);
console.log(
  `evidence: ${path.relative(root, outDir)}/claude-fulltest-smoke.{json,jsonl} + report copies`,
);
process.exitCode = checks.result === 'PASS' ? 0 : 1;

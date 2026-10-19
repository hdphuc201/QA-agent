#!/usr/bin/env node
// End-to-end plugin smoke inside Claude Code (uses the Claude API; small cost):
//   1. `claude plugin validate <root>`
//   2. `claude -p --plugin-dir <root> "/qa-agent:discover --smoke <demo-url>"` from an empty temp dir
//   3. checks the stream-json transcript: plugin loaded, 6 skills discovered, Playwright MCP
//      connected, browser tools really called, and the per-run token observed.
// Must run in a normal terminal: Claude Code refuses to start inside another Claude Code session.
// Usage: node scripts/smoke/claude-plugin-smoke.mjs [--out evidence/P1] [--budget 1]

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startDemoServer } from './demo-server.mjs';
import { makeTextRedactor, redactFile, redactTranscript } from './redact.mjs';

const redactText = makeTextRedactor();

const SKILLS = ['discover', 'plan', 'generate', 'run', 'report', 'full-test'];
const TOOL_PREFIX = 'mcp__plugin_qa-agent_playwright__';
const BROWSER_TOOLS = ['browser_navigate', 'browser_snapshot', 'browser_close'].map(
  (t) => TOOL_PREFIX + t,
);
const TIMEOUT_MS = 600_000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: { out: { type: 'string' }, budget: { type: 'string' } } });
const outDir = path.resolve(root, values.out ?? 'evidence/P1');
fs.mkdirSync(outDir, { recursive: true });

if (process.env.CLAUDECODE) {
  console.error(
    'Refusing to run: CLAUDECODE is set (this is a Claude Code session). Run this script in a normal terminal.',
  );
  process.exit(2);
}

/** @type {string[]} */
const log = [];
/** @param {string} line */
const say = (line) => {
  log.push(line);
  process.stdout.write(`${line}\n`);
};
/** @type {Record<string, unknown>} */
const checks = {
  startedAt: new Date().toISOString(),
  platform: `${process.platform} ${os.release()}`,
  node: process.version,
};

const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
checks.claudeVersion = version.stdout.trim();
say(`$ claude --version -> exit=${version.status}: ${checks.claudeVersion}`);

const validate = spawnSync('claude', ['plugin', 'validate', root], { encoding: 'utf8' });
checks.validateExit = validate.status;
say(
  `$ claude plugin validate <root> -> exit=${validate.status}\n${(validate.stdout + validate.stderr).trim()}`,
);

const demo = await startDemoServer();
checks.demoUrl = demo.url;
checks.token = demo.token;
say(`demo page ${demo.url} token=${demo.token}`);

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qa plugin smoke '));
const args = [
  '-p',
  '--plugin-dir',
  root,
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--max-budget-usd',
  values.budget ?? '1',
  '--allowedTools',
  ...BROWSER_TOOLS,
  '--',
  `/qa-agent:discover --smoke ${demo.url}`,
];
say(
  `$ (cwd: empty temp dir) claude ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`,
);

const transcriptFile = path.join(outDir, 'claude-plugin-smoke.jsonl');
const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => (stdout += d));
child.stderr.on('data', (d) => (stderr += d));
const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
const exitCode = await new Promise((resolve) => child.on('close', resolve));
clearTimeout(timer);
// Save the transcript before anything else can fail.
// Evidence is committed: strip home dir, user name and unrelated plugins/MCP servers/hooks.
fs.writeFileSync(transcriptFile, redactTranscript(stdout, redactText));
checks.claudeExit = exitCode;
await demo.close();
// Browser artifacts must stay inside the write allowlist (qa-artifacts/), never `.playwright-mcp/`.
const cwdEntries = fs.readdirSync(cwd);
checks.cwdEntries = cwdEntries;
checks.mcpArtifactsInAllowlist = fs.existsSync(path.join(cwd, 'qa-artifacts', 'playwright-mcp'));
// On Windows a lingering child (MCP server / browser) may still hold the temp cwd: retry, never crash.
try {
  fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  checks.tempCwdRemoved = true;
} catch (err) {
  checks.tempCwdRemoved = false;
  say(
    `warning: temp cwd not removed (${err instanceof Error ? err.message : String(err)}): ${cwd}`,
  );
}
if (stderr.trim()) say(`stderr:\n${stderr.trim().slice(-3000)}`);

/** @type {any[]} */
const events = stdout
  .split('\n')
  .filter((l) => l.trim().startsWith('{'))
  .map((l) => JSON.parse(l));
const init = events.find((e) => e.type === 'system' && e.subtype === 'init') ?? {};
const initText = JSON.stringify(init);
/** @type {any[]} */
const servers = init.mcp_servers ?? [];
const server = servers.find(
  (s) => String(s.name).includes('qa-agent') && String(s.name).includes('playwright'),
);
/** @type {string[]} */
const slash = init.slash_commands ?? [];
/** @type {string[]} */
const tools = init.tools ?? [];

checks.pluginInInit = /qa-agent/.test(JSON.stringify(init.plugins ?? []));
checks.plugins = init.plugins;
const skillsDiscovered = SKILLS.filter(
  (s) => slash.includes(`qa-agent:${s}`) || initText.includes(`qa-agent:${s}"`),
);
checks.skillsDiscovered = skillsDiscovered;
checks.mcpServer = server ?? null;
checks.mcpConnected = server?.status === 'connected';
checks.playwrightToolsInInit = tools.filter((t) => t.startsWith(TOOL_PREFIX));
checks.otherQaToolNames = tools.filter(
  (t) => t.includes('playwright') && !t.startsWith(TOOL_PREFIX),
);

const toolUses = events
  .filter((e) => e.type === 'assistant')
  .flatMap((e) => e.message?.content ?? [])
  .filter((c) => c.type === 'tool_use')
  .map((c) => c.name);
checks.toolUses = toolUses;
const toolResults = events
  .filter((e) => e.type === 'user')
  .flatMap((e) => e.message?.content ?? [])
  .filter((c) => c.type === 'tool_result');
checks.tokenInToolResult = toolResults.some((r) => JSON.stringify(r.content).includes(demo.token));
const result = events.find((e) => e.type === 'result');
checks.resultSubtype = result?.subtype;
checks.costUsd = result?.total_cost_usd;
checks.finalText = result?.result;
checks.observationLine =
  String(result?.result ?? '')
    .split('\n')
    .find((l) => l.includes('QA-AGENT-MCP-OBSERVATION')) ?? null;
checks.tokenInFinalAnswer = String(result?.result ?? '').includes(demo.token);

const required = {
  validatePassed: checks.validateExit === 0,
  claudeExited0: exitCode === 0,
  allSkillsDiscovered: skillsDiscovered.length === SKILLS.length,
  mcpConnected: checks.mcpConnected,
  navigateCalled: toolUses.includes(`${TOOL_PREFIX}browser_navigate`),
  snapshotCalled: toolUses.includes(`${TOOL_PREFIX}browser_snapshot`),
  tokenInToolResult: checks.tokenInToolResult,
  tokenInFinalAnswer: checks.tokenInFinalAnswer,
  noPlaywrightMcpDirInCwd: !cwdEntries.includes('.playwright-mcp'),
};
checks.required = required;
checks.result = Object.values(required).every(Boolean) ? 'PASS' : 'FAIL';
checks.finishedAt = new Date().toISOString();

fs.writeFileSync(
  path.join(outDir, 'claude-plugin-smoke.json'),
  `${JSON.stringify(checks, null, 2)}\n`,
);
fs.writeFileSync(path.join(outDir, 'claude-plugin-smoke.log'), `${log.join('\n')}\n`);
for (const name of ['claude-plugin-smoke.json', 'claude-plugin-smoke.log']) {
  redactFile(path.join(outDir, name), redactText);
}
say(`RESULT ${checks.result} ${JSON.stringify(required)}`);
say(`evidence: ${path.relative(root, outDir)}/claude-plugin-smoke.{json,jsonl,log}`);
process.exitCode = checks.result === 'PASS' ? 0 : 1;

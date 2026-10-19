#!/usr/bin/env node
// Runs the repository quality gate and saves one log per check under evidence/<phase>/.
// Usage: node scripts/quality-gate.mjs <phase> [--skip-live]   (exit 0 only if every check passed)
// Never stops at the first failure: every check runs and is reported.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv[2];
if (!phase || !/^P\d$/.test(phase)) {
  console.error('usage: node scripts/quality-gate.mjs <Px> [--skip-live]');
  process.exit(2);
}
const dir = path.join(root, 'evidence', phase);
fs.mkdirSync(dir, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = {
  ...process.env,
  FORCE_COLOR: '0',
  ...(process.argv.includes('--skip-live') ? { QA_AGENT_SKIP_LIVE: '1' } : {}),
};

/** @type {[string, string, string[]][]} */
const checks = [
  ['typecheck', npm, ['run', 'typecheck']],
  ['lint', npm, ['run', 'lint']],
  ['format-check', npm, ['run', 'format:check']],
  ['build', npm, ['run', 'build']],
  ['test', npm, ['test']],
  ['plugin-validate', 'claude', ['plugin', 'validate', '.']],
  ['progress-check', process.execPath, ['scripts/progress.mjs', 'check']],
];
let failed = 0;
for (const [name, cmd, args] of checks) {
  const started = new Date().toISOString();
  const r = spawnSync(cmd, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32' && cmd !== process.execPath,
  });
  const code = r.status ?? 1;
  if (code !== 0) failed++;
  fs.writeFileSync(
    path.join(dir, `${name}.log`),
    `$ ${[cmd === process.execPath ? 'node' : cmd, ...args].join(' ')}\n# started ${started} node ${process.version} on ${process.platform}\n${r.stdout ?? ''}${r.stderr ?? ''}\n# exit=${code}\n`,
  );
  const summary =
    name === 'test'
      ? (`${r.stdout}`.match(/^# (tests|pass|fail|skipped) \d+$/gm) ?? []).join(' ')
      : '';
  console.log(`${name}: exit=${code} ${summary}`.trim());
}
console.log(failed ? `QUALITY GATE: ${failed} check(s) failed` : 'QUALITY GATE: all checks passed');
process.exitCode = failed ? 1 : 0;

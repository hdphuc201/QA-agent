import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { credentialLeakReason } from '../../hooks/guard-credentials.mjs';
import { repoRoot } from '../helpers/sample-app.ts';

const HOOK = path.join(repoRoot, 'hooks/guard-credentials.mjs');
const SAFE_CHECK = `node -e "for (const k of Object.keys(process.env).filter((k) => k.startsWith('QA_AGENT_ACCOUNT_'))) console.log(k, process.env[k] ? 'set' : 'MISSING')"`;

const LEAKS = [
  'echo $QA_AGENT_ACCOUNT_DEMO_REQUESTER_PASSWORD',
  'echo "${QA_AGENT_ACCOUNT_DEMO_APPROVER_PASSWORD}"',
  'echo %QA_AGENT_ACCOUNT_DEMO_VIEWER_PASSWORD%',
  'Write-Output $env:QA_AGENT_ACCOUNT_DEMO_REQUESTER_PASSWORD',
  'Get-Item env:QA_AGENT_ACCOUNT_DEMO_REQUESTER_PASSWORD',
  'node -e "console.log(process.env.QA_AGENT_ACCOUNT_DEMO_REQUESTER_PASSWORD)"',
  `node -e "console.log(process.env['QA_AGENT_ACCOUNT_X_PASSWORD'])"`,
  'printenv QA_AGENT_ACCOUNT_DEMO_REQUESTER_PASSWORD',
  'QA_AGENT_ACCOUNT_DEMO_REQUESTER_PASSWORD=hunter2 npx playwright test',
  'env',
  'env | grep QA_AGENT',
  'printenv | sort',
  'set',
  'export -p',
  'Get-ChildItem env:',
  'gci env:* | Format-Table',
  'ls env:',
  '[System.Environment]::GetEnvironmentVariables()',
  'node -e "console.log(process.env)"',
  'node -e "console.log(JSON.stringify(process.env))"',
];
const ALLOWED = [
  SAFE_CHECK,
  'npm test',
  'node scripts/quality-gate.mjs P8',
  'env FORCE_COLOR=0 npx playwright test',
  'export QA_AGENT_BROWSER_CHANNEL=chrome',
  'echo $QA_AGENT_ACCOUNT_DEMO_REQUESTER_USERNAME',
  'git commit -m "set up"',
  'Get-ChildItem env:QA_AGENT_BROWSER_CHANNEL',
  'grep -rn QA_AGENT_ACCOUNT_ docs',
];

const run = (event: unknown) =>
  spawnSync(process.execPath, [HOOK], {
    input: typeof event === 'string' ? event : JSON.stringify(event),
    encoding: 'utf8',
  });

describe('credential guard hook (P8-T06)', () => {
  test('refuses commands that print or embed passwords, or dump the environment', () => {
    for (const c of LEAKS) assert.ok(credentialLeakReason(c), `should refuse: ${c}`);
  });

  test('allows normal commands and the documented presence check', () => {
    for (const c of ALLOWED) assert.equal(credentialLeakReason(c), null, `should allow: ${c}`);
  });

  test('speaks the PreToolUse protocol: deny JSON on a match, silence otherwise, never blocks on bad input', () => {
    const denied = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'env' },
    });
    assert.equal(denied.status, 0);
    const out = JSON.parse(denied.stdout) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /'set' : 'MISSING'/);
    for (const event of [
      { tool_name: 'Bash', tool_input: { command: 'npm test' } },
      { tool_name: 'Read', tool_input: { file_path: 'env' } },
      'not json',
    ]) {
      const r = run(event);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
    }
  });

  test('is registered for Bash and PowerShell in the plugin hooks file', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'hooks/hooks.json'), 'utf8')) as {
      hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
    };
    const entry = cfg.hooks.PreToolUse[0];
    assert.equal(entry?.matcher, 'Bash|PowerShell');
    assert.match(
      entry?.hooks[0]?.command ?? '',
      /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/guard-credentials\.mjs/,
    );
  });
});

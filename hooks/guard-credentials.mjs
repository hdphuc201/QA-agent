#!/usr/bin/env node
// PreToolUse hook (threat model T5): stop shell commands that would print or embed QA Agent
// account passwords in the session transcript. Reads the hook event (JSON) from stdin; on a match
// it answers with a "deny" decision, otherwise it stays silent (exit 0, no output = no opinion).
// Checking whether credentials are present is fine: print only "set"/"MISSING", never the value.

import { pathToFileURL } from 'node:url';

const SECRET_VAR = /QA_AGENT_ACCOUNT_[A-Z0-9_]+_PASSWORD/;

/**
 * Why a shell command is refused, or null. Exported for unit tests.
 * @param {unknown} command
 * @returns {string | null}
 */
export function credentialLeakReason(command) {
  const c = String(command ?? '');
  const v = SECRET_VAR.source;
  /** @type {[RegExp, string][]} */
  const rules = [
    [new RegExp(`(?:\\$\\{?|%|\\benv:)${v}`, 'i'), 'it expands a QA Agent password variable'],
    [
      new RegExp(`process\\.env(?:\\.${v}|\\[\\s*['"\`]${v})`),
      'it reads a QA Agent password variable',
    ],
    [new RegExp(`\\bprintenv\\s+${v}`), 'it prints a QA Agent password variable'],
    [
      new RegExp(`(?:^|[\\s;&|(])${v}=(?!\\s|$)`, 'm'),
      'it puts a password value into the command line',
    ],
    [
      /(?:^|[;&|(]\s*)(?:env|printenv|set|export\s+-p)\s*(?:$|[|;&>)])/m,
      'it dumps the whole environment',
    ],
    [
      /\b(?:Get-ChildItem|gci|dir|ls|Get-Item)\s+(?:-Path\s+)?env:[\\/]?(?:\*|\s|$|[|;)])/im,
      'it lists the whole environment',
    ],
    [
      /\[(?:System\.)?Environment\]::GetEnvironmentVariables\(\s*\)/i,
      'it dumps the whole environment',
    ],
    [
      /(?:console\.(?:log|dir|error)|JSON\.stringify|util\.inspect)\(\s*process\.env\s*[),]/,
      'it prints the whole environment',
    ],
  ];
  for (const [re, why] of rules) if (re.test(c)) return why;
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return; // not our business; never block on malformed input
  }
  if (!['Bash', 'PowerShell'].includes(event?.tool_name)) return;
  const why = credentialLeakReason(event?.tool_input?.command);
  if (!why) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `QA Agent credential guard: refused because ${why}. Credential values must never appear in the transcript. To check them, print only presence: node -e "for (const k of Object.keys(process.env).filter((k) => k.startsWith('QA_AGENT_ACCOUNT_'))) console.log(k, process.env[k] ? 'set' : 'MISSING')"`,
      },
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

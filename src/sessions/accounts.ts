// Account references → credentials from the environment. Config and reports only ever hold the
// account key (e.g. `demo.requester`); values come from QA_AGENT_ACCOUNT_<KEY>_USERNAME/_PASSWORD.

import type { Credentials } from '../discovery/explorer.ts';

export type Env = Readonly<Record<string, string | undefined>>;

/** `demo.requester` → `QA_AGENT_ACCOUNT_DEMO_REQUESTER` */
export function accountEnvPrefix(accountKey: string): string {
  return `QA_AGENT_ACCOUNT_${accountKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function resolveCredentials(accountKey: string, env: Env = process.env): Credentials | null {
  const prefix = accountEnvPrefix(accountKey);
  const username = env[`${prefix}_USERNAME`];
  const password = env[`${prefix}_PASSWORD`];
  return username && password ? { username, password } : null;
}

/** Names of the variables a role needs (for BLOCKED messages; never the values). */
export function requiredEnvVars(accountKey: string): string[] {
  const prefix = accountEnvPrefix(accountKey);
  return [`${prefix}_USERNAME`, `${prefix}_PASSWORD`];
}

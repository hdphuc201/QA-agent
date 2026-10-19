// Execution-layer safety policies (threat model T2): production environments and destructive steps.

import type { Assertion, Step } from '../planning/schema.ts';
import type { ProjectConfig } from './project-config.schema.ts';

export class PolicyError extends Error {
  override name = 'PolicyError';
}

/** Live browser work (exploration, test runs) never targets production without explicit approval. */
export function assertEnvironmentAllowed(
  config: Pick<ProjectConfig, 'environment'>,
  env: Readonly<Record<string, string | undefined>>,
  what: string,
): void {
  if (config.environment === 'production' && env.QA_AGENT_ALLOW_PRODUCTION !== '1') {
    throw new PolicyError(
      `refusing to ${what} against a production environment (set QA_AGENT_ALLOW_PRODUCTION=1 only with explicit owner approval)`,
    );
  }
}

const DESTRUCTIVE_NAME =
  /\b(delete|remove|destroy|purge|drop|erase|wipe|deactivate|terminate|revoke)\b/i;

/** Why a step or assertion is destructive, or null. */
export function destructiveReason(x: Step | Assertion): string | null {
  if ('do' in x && x.do === 'click' && DESTRUCTIVE_NAME.test(x.name)) return `clicks "${x.name}"`;
  if ('kind' in x && x.kind === 'apiStatus' && x.method === 'DELETE')
    return `sends DELETE ${x.path}`;
  return null;
}

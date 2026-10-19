// Playwright JSON results (per run phase) + plan → one normalised result per case.
// Statuses: PASS / FAIL (runner verdict), SKIPPED (deliberately skipped), BLOCKED (a precondition
// outside the app is missing, or the plan blocked the case), NOT_RUN (never executed).

import fs from 'node:fs';
import path from 'node:path';
import type { RunRecord } from '../orchestrator/run.ts';
import type { TestPlan } from '../planning/schema.ts';

export type QaStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'BLOCKED' | 'NOT_RUN';

export interface Attachment {
  name: string;
  contentType: string;
  path: string; // project-relative
}

export interface NormalizedResult {
  runId: string;
  caseId: string;
  title: string;
  requirementRefs: string[];
  category: string;
  priority: string;
  status: QaStatus;
  runnerStatus: string | null;
  flaky: boolean;
  attempts: number;
  durationMs: number;
  browser: string | null;
  phase: string | null;
  worker: number | null;
  startTime: string | null;
  buildId: string;
  error: { message: string; location: string | null } | null;
  attachments: Attachment[];
  sessionEvents: string[];
  note: string | null;
  dependsOn: string[];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** Values that must never appear in reports: every QA_AGENT_ACCOUNT_*_PASSWORD in the environment. */
export function secretValues(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => /^QA_AGENT_ACCOUNT_.+_PASSWORD$/.test(k) && v && v.length >= 3)
    .map(([, v]) => v as string);
}

export function cleanText(text: string, secrets: string[]): string {
  let out = text.replace(ANSI, '');
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}

interface PwResult {
  status: string;
  duration: number;
  workerIndex?: number;
  startTime?: string;
  retry?: number;
  error?: { message?: string; location?: { file: string; line: number; column: number } };
  errors?: { message?: string }[];
  attachments?: { name: string; contentType: string; path?: string }[];
  annotations?: { type: string; description?: string }[];
}
interface PwTest {
  projectName?: string;
  status?: string; // expected | unexpected | flaky | skipped
  results: PwResult[];
  annotations?: { type: string; description?: string }[];
}
interface PwSpec {
  title: string;
  tests: PwTest[];
}
interface PwSuite {
  specs?: PwSpec[];
  suites?: PwSuite[];
}

function* specsOf(suite: PwSuite): Generator<PwSpec> {
  for (const s of suite.specs ?? []) yield s;
  for (const c of suite.suites ?? []) yield* specsOf(c);
}

export function normalizeRun(options: {
  projectRoot: string;
  record: RunRecord;
  plan: TestPlan;
  env?: Readonly<Record<string, string | undefined>>;
}): NormalizedResult[] {
  const { projectRoot, record, plan } = options;
  const secrets = secretValues(options.env ?? process.env);
  const rel = (p: string) => path.relative(projectRoot, p).split(path.sep).join('/');
  const seen = new Map<string, NormalizedResult>();

  for (const phase of record.phases) {
    const file = path.join(projectRoot, phase.resultsFile);
    if (!fs.existsSync(file)) continue;
    const report = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      suites: PwSuite[];
      errors?: { message?: string }[];
    };
    // Playwright 1.63 reports a test cut off by --global-timeout as "skipped"; that is not a
    // deliberate skip, so such results become NOT_RUN unless the test carries a skip annotation.
    const cutOff = (report.errors ?? []).some((e) =>
      /Timed out waiting \S+ for the test suite to run/.test(e.message ?? ''),
    );
    for (const spec of report.suites.flatMap((s) => [...specsOf(s)])) {
      const caseId = spec.title.split(' ')[0] ?? '';
      const c = plan.cases.find((x) => x.id === caseId);
      if (!c) continue; // not a plan case (custom spec)
      for (const t of spec.tests) {
        const last = t.results.at(-1);
        const message = last?.error?.message ?? last?.errors?.[0]?.message ?? null;
        const blocked = message?.includes('QA_AGENT_BLOCKED') ?? false;
        let status: QaStatus;
        switch (last?.status) {
          case 'passed':
            status = 'PASS';
            break;
          case 'skipped': {
            const deliberate = [...(t.annotations ?? []), ...(last.annotations ?? [])].some(
              (a) => a.type === 'skip' || a.type === 'fixme',
            );
            status = cutOff && !deliberate ? 'NOT_RUN' : 'SKIPPED';
            break;
          }
          case 'interrupted':
            status = 'NOT_RUN';
            break;
          case 'failed':
          case 'timedOut':
            status = blocked ? 'BLOCKED' : 'FAIL';
            break;
          default:
            status = 'NOT_RUN';
        }
        const loc = last?.error?.location;
        seen.set(caseId, {
          runId: record.runId,
          caseId,
          title: c.title,
          requirementRefs: c.requirementRefs,
          category: c.category,
          priority: c.priority,
          status,
          runnerStatus: last?.status ?? null,
          flaky: t.status === 'flaky',
          attempts: t.results.length,
          durationMs: t.results.reduce((n, r) => n + r.duration, 0),
          browser: t.projectName ?? null,
          phase: phase.name,
          worker: last?.workerIndex ?? null,
          startTime: last?.startTime ?? null,
          buildId: record.metadata.buildId,
          error: message
            ? {
                message: cleanText(message, secrets).split('\n').slice(0, 12).join('\n').trim(),
                location: loc ? `${rel(loc.file)}:${loc.line}:${loc.column}` : null,
              }
            : null,
          attachments: (last?.attachments ?? [])
            .filter((a) => a.path)
            .map((a) => ({ name: a.name, contentType: a.contentType, path: rel(a.path ?? '') })),
          sessionEvents: (last?.annotations ?? [])
            .filter((a) => a.type === 'qa-session')
            .map((a) => a.description ?? ''),
          note: status === 'NOT_RUN' ? 'the run was interrupted before this test finished' : null,
          dependsOn: c.dependencies,
        });
      }
    }
  }

  // Every plan case gets exactly one result, executed or not.
  return plan.cases.map((c) => {
    const r = seen.get(c.id);
    if (r) return r;
    const notRunnable = c.status !== 'READY';
    return {
      runId: record.runId,
      caseId: c.id,
      title: c.title,
      requirementRefs: c.requirementRefs,
      category: c.category,
      priority: c.priority,
      status: c.status === 'BLOCKED' ? 'BLOCKED' : 'NOT_RUN',
      runnerStatus: null,
      flaky: false,
      attempts: 0,
      durationMs: 0,
      browser: null,
      phase: null,
      worker: null,
      startTime: null,
      buildId: record.metadata.buildId,
      error: null,
      attachments: [],
      sessionEvents: [],
      note: notRunnable
        ? `plan status ${c.status}: ${c.blockers.join('; ') || 'needs review'}`
        : 'READY but not executed in this run',
      dependsOn: c.dependencies,
    } satisfies NormalizedResult;
  });
}

// Requirement coverage: requirement → test cases → executions. Counts are kept apart on purpose:
// generated ≠ ready ≠ executed ≠ passed (roadmap §8.3).

import type { TestPlan } from '../planning/schema.ts';
import type { NormalizedResult, QaStatus } from './normalize.ts';

export type RequirementVerdict =
  'passing' | 'failing' | 'blocked' | 'not-run' | 'needs-review' | 'no-cases';

export interface RequirementCoverage {
  id: string;
  title: string;
  priority: string;
  cases: { id: string; planStatus: string; result: QaStatus }[];
  verdict: RequirementVerdict;
}

export interface CoverageSummary {
  requirements: number;
  withCases: number;
  withReadyCases: number;
  withExecutedCases: number;
  fullyPassing: number;
  counts: {
    generated: number;
    ready: number;
    executed: number;
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    notRun: number;
    flaky: number;
  };
  /** Requirements with at least one READY case / requirements in scope. Not "test coverage". */
  requirementCoverage: number;
  rows: RequirementCoverage[];
}

export function buildCoverage(
  plan: Pick<TestPlan, 'requirements' | 'cases'>,
  results: NormalizedResult[],
): CoverageSummary {
  const resultOf = (id: string) => results.find((r) => r.caseId === id)?.status ?? 'NOT_RUN';
  const rows = plan.requirements.map((req): RequirementCoverage => {
    const cases = plan.cases
      .filter((c) => c.requirementRefs.includes(req.id))
      .map((c) => ({ id: c.id, planStatus: c.status, result: resultOf(c.id) }));
    const ready = cases.filter((c) => c.planStatus === 'READY');
    let verdict: RequirementVerdict;
    if (cases.length === 0) verdict = 'no-cases';
    else if (ready.length === 0) verdict = 'needs-review';
    else if (ready.some((c) => c.result === 'FAIL')) verdict = 'failing';
    else if (ready.some((c) => c.result === 'BLOCKED')) verdict = 'blocked';
    else if (ready.every((c) => c.result === 'PASS')) verdict = 'passing';
    else verdict = 'not-run';
    return { id: req.id, title: req.title, priority: req.priority, cases, verdict };
  });
  // Executed = a real execution record (§8.3): skipped and never-run cases do not count.
  const executed = results.filter(
    (r) => r.runnerStatus !== null && r.status !== 'NOT_RUN' && r.status !== 'SKIPPED',
  );
  const count = (s: QaStatus) => results.filter((r) => r.status === s).length;
  const withReady = rows.filter((r) => r.cases.some((c) => c.planStatus === 'READY')).length;
  return {
    requirements: rows.length,
    withCases: rows.filter((r) => r.cases.length > 0).length,
    withReadyCases: withReady,
    withExecutedCases: rows.filter((r) =>
      r.cases.some((c) => executed.some((e) => e.caseId === c.id)),
    ).length,
    fullyPassing: rows.filter((r) => r.verdict === 'passing').length,
    counts: {
      generated: plan.cases.length,
      ready: plan.cases.filter((c) => c.status === 'READY').length,
      executed: executed.length,
      passed: count('PASS'),
      failed: count('FAIL'),
      blocked: count('BLOCKED'),
      skipped: count('SKIPPED'),
      notRun: count('NOT_RUN'),
      flaky: results.filter((r) => r.flaky).length,
    },
    requirementCoverage: rows.length ? Math.round((withReady / rows.length) * 1000) / 1000 : 0,
    rows,
  };
}

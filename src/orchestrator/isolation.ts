// Data-isolation analysis of a test case, used by the generator (tags) and the scheduler (workers).

import type { TestCase } from '../planning/schema.ts';

export type Isolation = 'isolated' | 'serial';

export interface IsolationVerdict {
  isolation: Isolation;
  reasons: string[];
}

/**
 * `isolated`: the case only mutates data it created itself (unique values, captured subject) or
 * nothing at all, so it can run in parallel with other cases.
 * `serial`: the case reads or mutates state other cases also change (e.g. "no X is created" counts
 * a shared list, or it acts on pre-existing records), so it must not overlap with them.
 */
export function analyzeIsolation(c: TestCase): IsolationVerdict {
  const reasons: string[] = [];
  const asserts = c.expectations.flatMap((e) => e.asserts);
  for (const a of asserts) {
    if (a.kind === 'apiCountUnchanged') reasons.push(`counts the shared list ${a.path}`);
  }
  const steps = [...c.setup, ...c.steps, ...c.expectations.flatMap((e) => e.before)];
  const createsSubject = steps.some((s) => s.do === 'click' && s.capture === 'subject');
  // Acting (fill/click) on a page that is not one of the case's own records.
  const touchesForeign = steps.some((s, i) => {
    if (s.do !== 'click' || s.capture === 'subject') return false;
    const lastGoto = [...steps.slice(0, i)].reverse().find((x) => x.do === 'goto' && x.as === s.as);
    return (
      !!lastGoto &&
      lastGoto.do === 'goto' &&
      !lastGoto.path.includes('{{subject') &&
      !createsSubject
    );
  });
  if (touchesForeign) reasons.push('acts on a record it did not create');
  for (const a of asserts) {
    if (
      a.kind === 'apiStatus' &&
      a.method !== 'GET' &&
      !a.path.includes('{{subject') &&
      a.status < 300
    ) {
      reasons.push(`changes shared state through ${a.method} ${a.path}`);
    }
  }
  return { isolation: reasons.length ? 'serial' : 'isolated', reasons };
}

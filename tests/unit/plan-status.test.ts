import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decideStatus, runnableCases } from '../../src/planning/planner.ts';
import type { TestCase } from '../../src/planning/schema.ts';

const expectation = {
  text: 't',
  source: { file: 'd', line: 1 },
  requirementId: 'R',
  before: [],
  asserts: [{ kind: 'url' as const, as: 'requester', path: '/' }],
};
const ok = {
  blockers: [] as string[],
  setup: [],
  steps: [{ do: 'goto' as const, as: 'requester', path: '/' }],
  expectations: [expectation],
};

describe('case statuses', () => {
  test('READY only when every step and assertion is automatable and nothing blocks', () => {
    assert.equal(decideStatus(ok), 'READY');
  });
  test('NEEDS_REVIEW: no expected result, a manual step, a manual assertion, or a soft blocker', () => {
    assert.equal(decideStatus({ ...ok, expectations: [] }), 'NEEDS_REVIEW');
    assert.equal(
      decideStatus({
        ...ok,
        steps: [{ do: 'manual', as: 'requester', text: 'do something vague' }],
      }),
      'NEEDS_REVIEW',
    );
    assert.equal(
      decideStatus({
        ...ok,
        expectations: [
          { ...expectation, asserts: [{ kind: 'manual', as: 'requester', text: 'looks nice' }] },
        ],
      }),
      'NEEDS_REVIEW',
    );
    assert.equal(
      decideStatus({ ...ok, blockers: ['expectation refers to data.x, which no step provides'] }),
      'NEEDS_REVIEW',
    );
  });
  test('BLOCKED wins over everything', () => {
    assert.equal(
      decideStatus({
        ...ok,
        blockers: ['BLOCKED: role "admin" has no account in the project config'],
      }),
      'BLOCKED',
    );
  });
  test('only READY cases reach the runner', () => {
    const cases = (['READY', 'NEEDS_REVIEW', 'BLOCKED', 'DRAFT'] as const).map(
      (status, i) => ({ id: `C-00${i}`, status }) as TestCase,
    );
    assert.deepEqual(
      runnableCases({ cases }).map((c) => c.id),
      ['C-000'],
    );
  });
});

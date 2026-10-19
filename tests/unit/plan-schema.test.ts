import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ExpectationSchema,
  RequirementSchema,
  StepSchema,
  TestCaseSchema,
} from '../../src/planning/schema.ts';

const src = { file: 'docs/requirements.md', line: 3 };
const expectation = {
  text: 'the alert "X" is shown',
  source: src,
  requirementId: 'DEMO-REQ-A-001',
  asserts: [{ kind: 'alert', as: 'requester', text: 'X' }],
};
const testCase = {
  schemaVersion: 1,
  id: 'DEMO-REQ-A-001-001',
  title: 't',
  feature: null,
  scenarioId: 'SCN-DEMO-REQ-A-001',
  category: 'negative',
  priority: 'P1',
  riskScore: 0.5,
  status: 'READY',
  requirementRefs: ['DEMO-REQ-A-001'],
  actors: [{ role: 'requester', accountKey: 'demo.requester' }],
  preconditions: [],
  setup: [],
  steps: [{ do: 'goto', as: 'requester', path: '/' }],
  expectations: [expectation],
  dependencies: [],
  blockers: [],
  provenance: { requirementSources: [src], mapRefs: [], generatedBy: 'qa-agent planner' },
  automation: { specPath: null },
};

describe('planning schemas reject invalid input', () => {
  test('a valid case parses and gets defaults', () => {
    const parsed = TestCaseSchema.parse(testCase);
    assert.deepEqual(parsed.data, {});
    assert.deepEqual(parsed.expectations[0]?.before, []);
  });

  test('invalid cases', () => {
    const bad: [string, unknown][] = [
      ['schemaVersion', { ...testCase, schemaVersion: 2 }],
      ['id format', { ...testCase, id: 'case one' }],
      ['status', { ...testCase, status: 'PASSED' }],
      ['category', { ...testCase, category: 'smoke' }],
      ['no requirement refs', { ...testCase, requirementRefs: [] }],
      ['risk out of range', { ...testCase, riskScore: 2 }],
      ['unknown step', { ...testCase, steps: [{ do: 'hack', as: 'x' }] }],
    ];
    for (const [what, value] of bad)
      assert.equal(TestCaseSchema.safeParse(value).success, false, what);
  });

  test('expectations need at least one assertion and a valid HTTP status', () => {
    assert.equal(ExpectationSchema.safeParse({ ...expectation, asserts: [] }).success, false);
    assert.equal(
      ExpectationSchema.safeParse({
        ...expectation,
        asserts: [{ kind: 'apiStatus', as: 'a', method: 'GET', path: '/x', status: 99 }],
      }).success,
      false,
    );
    assert.equal(
      StepSchema.safeParse({ do: 'fill', as: 'a', label: 'Title', value: { evil: 1 } }).success,
      false,
    );
  });

  test('requirement ids are stable uppercase identifiers', () => {
    const req = {
      schemaVersion: 1,
      id: 'DEMO-REQ-A-001',
      title: 't',
      feature: null,
      priority: 'P1',
      actors: [],
      given: [],
      when: [],
      expected: [],
      rules: [],
      boundaries: [],
      notes: [],
      source: src,
      mapRefs: [],
    };
    assert.equal(RequirementSchema.safeParse(req).success, true);
    assert.equal(RequirementSchema.safeParse({ ...req, id: 'req 1' }).success, false);
    assert.equal(RequirementSchema.safeParse({ ...req, priority: 'HIGH' }).success, false);
  });
});

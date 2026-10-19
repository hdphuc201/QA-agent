import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseProjectConfig } from '../../src/config/project-config.schema.ts';
import { buildPlan, resolveDependencies } from '../../src/planning/planner.ts';
import { parseRequirementsDoc } from '../../src/planning/requirements.ts';
import type { TestCase } from '../../src/planning/schema.ts';

const config = parseProjectConfig(
  {
    schemaVersion: 1,
    projectId: 'dedupe',
    baseURL: 'http://127.0.0.1:4100/',
    allowedOrigins: ['http://127.0.0.1:4100'],
    roles: [{ name: 'requester', accountKey: 'demo.requester' }],
  },
  'cfg',
);
const plan = (doc: string) =>
  buildPlan({
    config,
    requirements: parseRequirementsDoc({ path: 'd.md', content: doc }),
    map: null,
    generatedAt: 't',
    requirementsFiles: [],
    projectMapPath: null,
  });

const fake = (id: string, dependencies: string[], extra: Partial<TestCase> = {}) =>
  ({
    id,
    dependencies,
    blockers: [] as string[],
    status: 'DRAFT' as TestCase['status'],
    setup: [],
    steps: [{ do: 'goto', as: 'requester', path: '/' }],
    expectations: [
      {
        text: 't',
        source: { file: 'd', line: 1 },
        requirementId: 'R',
        before: [],
        asserts: [{ kind: 'url', as: 'requester', path: '/' }],
      },
    ],
    ...extra,
  }) as Pick<
    TestCase,
    'id' | 'dependencies' | 'blockers' | 'status' | 'setup' | 'steps' | 'expectations'
  >;

describe('deduplication', () => {
  test('identical behaviour and expected outcome from two requirements becomes one case with both refs', () => {
    const p = plan(`
### A-REQ-001 — Home
- Priority: P1
- Actors: requester
- When: the requester opens \`/\`
- Expected: the heading "Requests" is shown

### A-REQ-002 — Landing (same behaviour, other doc section)
- Priority: P0
- Actors: requester
- When: the requester opens \`/\`
- Expected: the heading "Requests" is shown
`);
    assert.equal(p.cases.length, 1);
    assert.deepEqual(p.cases[0]?.requirementRefs, ['A-REQ-001', 'A-REQ-002']);
    assert.deepEqual(p.duplicatesMerged, [{ kept: 'A-REQ-001-001', merged: 'A-REQ-002-001' }]);
    assert.equal(
      p.cases[0]?.priority,
      'P0',
      'merging keeps the highest priority (A-REQ-002 is P0)',
    );
  });

  test('same action with a different expected outcome is not a duplicate', () => {
    const p = plan(`
### A-REQ-001 — One
- Actors: requester
- When: the requester opens \`/\`
- Expected: the heading "Requests" is shown

### A-REQ-002 — Two
- Actors: requester
- When: the requester opens \`/\`
- Expected: the heading "Inbox" is shown
`);
    assert.equal(p.cases.length, 2);
    assert.deepEqual(p.duplicatesMerged, []);
  });
});

describe('risk ranking', () => {
  test('cases are ordered by risk score; priority derives from impact x likelihood', () => {
    const p = plan(`
### A-REQ-001 — Low
- Priority: P2
- Actors: requester
- When: the requester opens \`/\`
- Expected: the heading "Requests" is shown

### A-REQ-002 — High
- Priority: P0
- Actors: anonymous
- When: an anonymous user opens \`/\`
- Expected: the user is redirected to \`/login\`
`);
    assert.deepEqual(
      p.cases.map((c) => [c.id, c.category, c.riskScore, c.priority]),
      [
        ['A-REQ-002-001', 'rbac', 1, 'P0'],
        ['A-REQ-001-001', 'happy', 0.21, 'P2'],
      ],
    );
  });
});

describe('dependencies', () => {
  test('a dependency cycle blocks every case on it', () => {
    const cases = resolveDependencies([
      fake('A-001', ['B-001']),
      fake('B-001', ['A-001']),
      fake('C-001', []),
    ]);
    assert.deepEqual(
      cases.map((c) => c.status),
      ['BLOCKED', 'BLOCKED', 'READY'],
    );
    assert.match(cases[0]?.blockers.join() ?? '', /dependency cycle A-001 -> B-001 -> A-001/);
  });

  test('a case depending on a non-READY case is BLOCKED, transitively', () => {
    const review = fake('D-001', [], { expectations: [] });
    const cases = resolveDependencies([fake('E-001', ['D-001']), fake('F-001', ['E-001']), review]);
    assert.deepEqual(
      cases.map((c) => [c.id, c.status]),
      [
        ['E-001', 'BLOCKED'],
        ['F-001', 'BLOCKED'],
        ['D-001', 'NEEDS_REVIEW'],
      ],
    );
    assert.match(cases[1]?.blockers.join() ?? '', /depends on E-001/);
  });

  test('a subject nobody can produce blocks the case instead of guessing setup data', () => {
    const p = plan(`
### A-REQ-001 — Approve
- Actors: requester
- Given: a pending invoice created by the requester
- When: the requester opens the invoice
- Expected: the heading "Invoice" is shown
`);
    assert.equal(p.cases[0]?.status, 'BLOCKED');
    assert.match(
      p.cases[0]?.blockers.join() ?? '',
      /no READY case produces a "Pending" subject created by requester/,
    );
  });

  test('roles without an account in the config block the case', () => {
    const p = plan(`
### A-REQ-001 — Admin
- Actors: admin
- When: the admin opens \`/admin\`
- Expected: the heading "Admin" is shown
`);
    assert.equal(p.cases[0]?.status, 'BLOCKED');
    assert.match(p.cases[0]?.blockers.join() ?? '', /role "admin" has no account/);
  });
});

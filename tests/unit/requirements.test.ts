import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProjectMapFile } from '../../src/discovery/discover.ts';
import {
  linkRequirements,
  parseRequirementsDoc,
  splitActors,
  unreferencedRoutes,
} from '../../src/planning/requirements.ts';

const doc = `# Spec

## Section

### SHOP-REQ-001 — Checkout
- Feature: Checkout
- Priority: P0
- Actors: buyer, admin
- Given: the buyer is on \`/cart\`
- When: the buyer clicks "Pay"
- Expected: the alert "Paid" is shown
- Expected (late): \`GET /api/orders\` returns HTTP 200
- Boundary (accepted): quantity 1, 99
- Something: free text

## Other heading
- Expected: not part of any requirement

### SHOP-REQ-002 — Vague
- Priority: urgent
- Note: should be fast
`;

const map = {
  routes: [
    { id: 'route-001', method: 'GET', path: '/cart' },
    { id: 'route-002', method: 'GET', path: '/api/orders' },
    { id: 'route-003', method: 'POST', path: '/api/orders' },
    { id: 'route-004', method: 'GET', path: '/admin' },
  ],
  ui: [{ id: 'ui-001', role: 'button', name: 'Pay' }],
} as unknown as ProjectMapFile;

describe('requirements mapper', () => {
  test('parses ids, fields, labelled expectations, boundaries and source lines', () => {
    const [a, b, extra] = parseRequirementsDoc({ path: 'docs/spec.md', content: doc });
    assert.equal(extra, undefined, 'text under a non-requirement heading is ignored');
    assert.ok(a && b);
    assert.equal(a.id, 'SHOP-REQ-001');
    assert.deepEqual(a.source, { file: 'docs/spec.md', line: 5 });
    assert.deepEqual(a.actors, ['buyer', 'admin']);
    assert.deepEqual(
      a.expected.map((e) => [e.label, e.source.line]),
      [
        [null, 11],
        ['late', 12],
      ],
    );
    assert.deepEqual(a.boundaries, [{ label: 'accepted', field: 'quantity', values: ['1', '99'] }]);
    assert.deepEqual(a.notes, ['Something: free text']);
    assert.equal(b.priority, 'P2');
    assert.match(b.notes.join('|'), /invalid priority "urgent"/);
    assert.deepEqual(b.expected, [], 'a requirement without Expected lines has no expected result');
  });

  test('links mentioned paths and UI names to map items; reports unreferenced routes', () => {
    const reqs = linkRequirements(parseRequirementsDoc({ path: 'd.md', content: doc }), map);
    assert.deepEqual(reqs[0]?.mapRefs, ['route-001', 'route-002', 'ui-001']);
    assert.deepEqual(unreferencedRoutes(reqs, map), ['POST /api/orders', 'GET /admin']);
  });

  test('actor lists', () => {
    assert.deepEqual(splitActors('a requester or viewer'), ['requester', 'viewer']);
    assert.deepEqual(splitActors('requester, approver and admin'), [
      'requester',
      'approver',
      'admin',
    ]);
  });
});

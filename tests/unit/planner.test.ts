import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseProjectConfig } from '../../src/config/project-config.schema.ts';
import { mergeDiscovery, type ProjectMapFile } from '../../src/discovery/discover.ts';
import { buildStaticMap } from '../../src/discovery/project-map.ts';
import { readProjectSources } from '../../src/discovery/source-reader.ts';
import {
  interpretExpected,
  interpretWhen,
  parseFieldSpecs,
  sentenceActors,
  splitActions,
} from '../../src/planning/interpret.ts';
import { buildPlan, decideStatus, findCycles, riskOf } from '../../src/planning/planner.ts';
import { linkRequirements, parseRequirementsDoc } from '../../src/planning/requirements.ts';
import type { TestPlan } from '../../src/planning/schema.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appDir = path.join(repoRoot, 'examples/sample-app');
const config = parseProjectConfig(
  JSON.parse(fs.readFileSync(path.join(appDir, '.qa-agent/config.json'), 'utf8')),
  'cfg',
);

/** Static discovery of the sample app (no browser) + its requirements → plan. */
function samplePlan(): { plan: TestPlan; map: ProjectMapFile } {
  const read = readProjectSources(appDir, {
    docsPaths: config.docsPaths,
    sourcePaths: config.sourcePaths,
  });
  const map = mergeDiscovery(
    config,
    read,
    buildStaticMap(
      read.files,
      config.roles.map((r) => r.name),
    ),
    null,
    't',
  );
  const doc = read.files.find((f) => f.path === 'docs/requirements.md');
  assert.ok(doc);
  const requirements = linkRequirements(parseRequirementsDoc(doc), map);
  return {
    plan: buildPlan({
      config,
      requirements,
      map,
      generatedAt: 't',
      requirementsFiles: [doc.path],
      projectMapPath: null,
    }),
    map,
  };
}

const plan = samplePlan().plan;
const byId = (id: string) => {
  const c = plan.cases.find((x) => x.id === id);
  assert.ok(c, id);
  return c;
};

describe('interpreter', () => {
  const { map } = samplePlan();
  const ctx = { map, roles: ['requester', 'approver', 'viewer'] };

  test('splits actions only before verbs and finds the acting roles', () => {
    assert.deepEqual(splitActions('the approver opens the request and clicks "Approve"'), [
      'the approver opens the request',
      'clicks "Approve"',
    ]);
    assert.deepEqual(splitActions('submits "X" with a title and an amount of 5'), [
      'submits "X" with a title and an amount of 5',
    ]);
    assert.deepEqual(sentenceActors('a requester or viewer tries to approve it', ctx.roles), [
      'requester',
      'viewer',
    ]);
    assert.deepEqual(sentenceActors('an anonymous user opens `/`', ctx.roles), ['anonymous']);
  });

  test('field specs: unique, literal, empty, boundary placeholder', () => {
    assert.deepEqual(parseFieldSpecs('a title and an amount of 250'), [
      { noun: 'title', value: { unique: 'title' } },
      { noun: 'amount', value: { literal: '250' } },
    ]);
    assert.deepEqual(parseFieldSpecs('an empty title'), [
      { noun: 'title', value: { literal: '' } },
    ]);
    assert.deepEqual(parseFieldSpecs('the amount under test'), [
      { noun: 'amount', value: { ref: 'boundary.amount' } },
    ]);
  });

  test('submits a form found through the project map (link → form → submit button)', () => {
    assert.deepEqual(
      interpretWhen(
        ctx,
        'requester',
        'the requester submits "New request" with a title and an amount of 250',
      ),
      [
        { do: 'goto', as: 'requester', path: '/requests/new' },
        { do: 'fill', as: 'requester', label: 'Title', value: { unique: 'title' } },
        { do: 'fill', as: 'requester', label: 'Amount', value: { literal: '250' } },
        {
          do: 'click',
          as: 'requester',
          role: 'button',
          name: 'Create request',
          capture: 'subject',
        },
      ],
    );
    assert.deepEqual(
      interpretWhen(ctx, 'requester', 'the requester submits "Unknown form" with a title'),
      [
        {
          do: 'manual',
          as: 'requester',
          text: 'the requester submits "Unknown form" with a title',
        },
      ],
    );
  });

  test('expected sentences become assertions; unknown ones become manual', () => {
    const e = (s: string, actor = 'requester') => interpretExpected(ctx, actor, s);
    assert.deepEqual(e('`GET /api/requests` without a session returns HTTP 401').asserts, [
      { kind: 'apiStatus', as: 'anonymous', method: 'GET', path: '/api/requests', status: 401 },
    ]);
    assert.deepEqual(
      e(
        'rejecting without a reason returns HTTP 400 from `POST /api/requests/<id>/reject`',
        'approver',
      ).asserts,
      [
        {
          kind: 'apiStatus',
          as: 'approver',
          method: 'POST',
          path: '/api/requests/{{subject.id}}/reject',
          status: 400,
          body: { reason: '' },
        },
      ],
    );
    assert.deepEqual(e('the requests page `/` is shown with the heading "Requests"').asserts, [
      { kind: 'url', as: 'requester', path: '/' },
      { kind: 'heading', as: 'requester', name: 'Requests' },
    ]);
    assert.deepEqual(e('no "Approve" button is shown to them').asserts, [
      { kind: 'absent', as: 'requester', role: 'button', name: 'Approve' },
    ]);
    const other = e('the requester sees the status "Approved" for that request', 'approver');
    assert.deepEqual(other.before, [{ do: 'goto', as: 'requester', path: '{{subject.path}}' }]);
    assert.deepEqual(e('no request is created').asserts, [
      { kind: 'apiCountUnchanged', as: 'requester', path: '/api/requests' },
    ]);
    assert.deepEqual(e('no widget is created').asserts, [
      { kind: 'manual', as: 'requester', text: 'no widget is created' },
    ]);
    assert.equal(e('it feels fast').asserts[0]?.kind, 'manual');
  });
});

describe('test matrix for the sample app', () => {
  test('cases per category and status', () => {
    const count = (f: (c: TestPlan['cases'][number]) => boolean) => plan.cases.filter(f).length;
    assert.equal(plan.cases.length, 21);
    assert.equal(
      count((c) => c.status === 'READY'),
      19,
    );
    assert.deepEqual(
      Object.fromEntries(
        ['happy', 'negative', 'boundary', 'rbac', 'state-transition'].map((k) => [
          k,
          count((c) => c.category === k),
        ]),
      ),
      { happy: 4, negative: 3, boundary: 4, rbac: 8, 'state-transition': 2 },
    );
    assert.deepEqual(plan.coverage.categoriesNotRequired, ['network-failure', 'concurrency']);
    assert.equal(plan.coverage.withReadyCases, 10);
  });

  test('boundary values each get a case with the matching expectation', () => {
    const one = byId('DEMO-REQ-REQ-003-001');
    const zero = byId('DEMO-REQ-REQ-003-003');
    assert.ok(
      one.steps.some(
        (s) =>
          s.do === 'fill' &&
          s.label === 'Amount' &&
          'literal' in s.value &&
          s.value.literal === '1',
      ),
    );
    assert.deepEqual(
      one.expectations.map((e) => e.asserts[0]?.kind),
      ['text'],
    );
    assert.deepEqual(
      zero.expectations.map((e) => e.asserts[0]?.kind),
      ['alert'],
    );
  });

  test('two-role workflow: requester creates (setup), approver acts, requester sees result', () => {
    const c = byId('DEMO-REQ-APP-001-001');
    assert.deepEqual(c.dependencies, ['DEMO-REQ-REQ-001-001']);
    assert.deepEqual(
      c.actors.map((a) => [a.role, a.accountKey]),
      [
        ['approver', 'demo.approver'],
        ['requester', 'demo.requester'],
      ],
    );
    assert.ok(
      c.setup.some((s) => s.do === 'click' && s.capture === 'subject' && s.as === 'requester'),
    );
    assert.deepEqual(
      c.steps.map((s) => `${s.as}:${s.do}`),
      ['approver:login', 'approver:goto', 'approver:click'],
    );
    assert.equal(c.category, 'state-transition');
  });

  test('every expectation quotes its requirement line (traceability)', () => {
    for (const c of plan.cases) {
      for (const e of c.expectations) {
        const req = plan.requirements.find((r) => r.id === e.requirementId);
        assert.ok(
          req?.expected.some((x) => x.text === e.text && x.source.line === e.source.line),
          `${c.id}: ${e.text}`,
        );
        assert.ok(c.requirementRefs.includes(e.requirementId));
      }
    }
  });

  test('network-failure / concurrency cases appear only when a requirement asks for them', () => {
    const doc =
      '### X-REQ-001 — Offline\n- Actors: requester\n- When: the network is unavailable\n- Expected: the alert "You are offline" is shown';
    const p = buildPlan({
      config,
      requirements: parseRequirementsDoc({ path: 'd.md', content: doc }),
      map: null,
      generatedAt: 't',
      requirementsFiles: [],
      projectMapPath: null,
    });
    assert.equal(p.cases[0]?.category, 'network-failure');
    assert.equal(
      p.cases[0]?.status,
      'NEEDS_REVIEW',
      'the network condition cannot be automated from text alone',
    );
  });

  test('risk and dependency helpers', () => {
    assert.deepEqual(riskOf('P0', 'rbac'), { score: 1, priority: 'P0' });
    assert.deepEqual(riskOf('P1', 'negative'), { score: 0.48, priority: 'P1' });
    assert.deepEqual(riskOf('P2', 'happy'), { score: 0.21, priority: 'P2' });
    assert.deepEqual(
      findCycles(
        new Map([
          ['A', ['B']],
          ['B', []],
        ]),
      ),
      [],
    );
    assert.equal(
      decideStatus({ blockers: [], setup: [], steps: [], expectations: [] }),
      'NEEDS_REVIEW',
    );
  });
});

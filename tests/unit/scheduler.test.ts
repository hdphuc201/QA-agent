import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { parseProjectConfig } from '../../src/config/project-config.schema.ts';
import { analyzeIsolation } from '../../src/orchestrator/isolation.ts';
import { buildSchedule, ScheduleError } from '../../src/orchestrator/scheduler.ts';
import { TestPlanSchema, type TestCase } from '../../src/planning/schema.ts';
import { repoRoot } from '../helpers/sample-app.ts';

const plan = TestPlanSchema.parse(
  JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/fixtures/sample-test-plan.json'), 'utf8')),
);
const baseConfig = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'examples/sample-app/.qa-agent/config.json'), 'utf8'),
);
const config = (workers: { max: number; writeHeavy: number }) =>
  parseProjectConfig({ ...baseConfig, workers }, 'cfg');
const byId = (id: string): TestCase => {
  const c = plan.cases.find((x) => x.id === id);
  assert.ok(c, id);
  return structuredClone(c);
};

describe('isolation analysis', () => {
  test('cases that create their own data are isolated; shared-list counts are serial', () => {
    for (const id of [
      'DEMO-REQ-APP-001-001',
      'DEMO-REQ-REQ-001-001',
      'DEMO-REQ-APP-003-002',
      'DEMO-REQ-AUTH-002-001',
    ]) {
      assert.equal(analyzeIsolation(byId(id)).isolation, 'isolated', id);
    }
    assert.deepEqual(analyzeIsolation(byId('DEMO-REQ-REQ-002-001')), {
      isolation: 'serial',
      reasons: ['counts the shared list /api/requests'],
    });
  });

  test('acting on a record the case did not create, or POSTing to shared state, is serial', () => {
    const c = byId('DEMO-REQ-APP-001-001');
    c.setup = [];
    c.steps = [
      { do: 'login', as: 'approver', invalidPassword: false, implicit: true },
      { do: 'goto', as: 'approver', path: '/requests/REQ-1' },
      { do: 'click', as: 'approver', role: 'button', name: 'Approve' },
    ];
    assert.deepEqual(analyzeIsolation(c).reasons, ['acts on a record it did not create']);
    const d = byId('DEMO-REQ-VIEW-001-003');
    const first = d.expectations[0];
    assert.ok(first);
    first.asserts = [
      { kind: 'apiStatus', as: 'viewer', method: 'POST', path: '/api/settings', status: 200 },
    ];
    assert.deepEqual(analyzeIsolation(d).reasons, [
      'changes shared state through POST /api/settings',
    ]);
  });
});

describe('schedule', () => {
  test('sample plan: dependency levels, 19 parallel + 1 serial, worker budget', () => {
    const s = buildSchedule(plan, config({ max: 2, writeHeavy: 1 }));
    assert.equal(s.parallel.length, 19);
    assert.deepEqual(s.serial, ['DEMO-REQ-REQ-002-001']);
    assert.deepEqual(s.workers, { parallel: 2, serial: 1 });
    assert.equal(s.levels.length, 2);
    assert.ok(s.levels[0]?.includes('DEMO-REQ-REQ-001-001'));
    assert.ok(s.levels[1]?.includes('DEMO-REQ-APP-001-001'));
    for (const c of s.cases)
      for (const d of c.dependsOn)
        assert.ok((s.cases.find((x) => x.id === d)?.level ?? 99) < c.level);
    assert.match(s.rationale.join('\n'), /DEMO-REQ-REQ-002-001: counts the shared list/);
  });

  test('budget: workers.max=1 → 1; large max is capped at 2; one isolated case → 1', () => {
    assert.equal(buildSchedule(plan, config({ max: 1, writeHeavy: 1 })).workers.parallel, 1);
    assert.equal(buildSchedule(plan, config({ max: 8, writeHeavy: 1 })).workers.parallel, 2);
    const single = { cases: plan.cases.filter((c) => c.id === 'DEMO-REQ-AUTH-001-001') };
    assert.equal(buildSchedule(single, config({ max: 2, writeHeavy: 1 })).workers.parallel, 1);
  });

  test('only READY cases are scheduled; a cycle among READY cases is refused', () => {
    const s = buildSchedule(plan, config({ max: 2, writeHeavy: 1 }));
    assert.ok(!s.cases.some((c) => c.id === 'DEMO-REQ-REQ-004-001'));
    const a = byId('DEMO-REQ-AUTH-001-001');
    const b = byId('DEMO-REQ-AUTH-002-001');
    a.dependencies = [b.id];
    b.dependencies = [a.id];
    assert.throws(
      () => buildSchedule({ cases: [a, b] }, config({ max: 2, writeHeavy: 1 })),
      ScheduleError,
    );
  });
});

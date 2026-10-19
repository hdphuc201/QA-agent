import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  caseToTest,
  GenerationError,
  pageVar,
  pathExpr,
  q,
  specFileName,
} from '../../src/generator/codegen.ts';
import { fixturesSource } from '../../src/generator/generate.ts';
import { parseProjectConfig } from '../../src/config/project-config.schema.ts';
import { TestPlanSchema, type TestCase } from '../../src/planning/schema.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const plan = TestPlanSchema.parse(
  JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/fixtures/sample-test-plan.json'), 'utf8')),
);
const ready = plan.cases.filter((c) => c.status === 'READY');
const byId = (id: string): TestCase => {
  const c = plan.cases.find((x) => x.id === id);
  assert.ok(c, id);
  return c;
};

describe('codegen', () => {
  test('only READY cases are generated; manual steps or checks are refused', () => {
    assert.throws(() => caseToTest(byId('DEMO-REQ-REQ-004-001')), GenerationError);
    const c = structuredClone(byId('DEMO-REQ-AUTH-001-001'));
    c.steps.push({ do: 'manual', as: 'requester', text: 'look around' });
    assert.throws(() => caseToTest(c), /manual step cannot be generated/);
  });

  test('locators are role/label based; no CSS or XPath selectors', () => {
    for (const c of ready) {
      const src = caseToTest(c);
      assert.doesNotMatch(src, /\.locator\(|\$\(|\$\$\(|xpath=|css=|querySelector/, c.id);
      for (const m of src.matchAll(/\.getBy(\w+)\(/g))
        assert.ok(['Role', 'Label', 'Text'].includes(m[1] ?? ''), `${c.id}: getBy${m[1]}`);
    }
  });

  test('every structured assertion becomes exactly one expect* call (nothing dropped or added)', () => {
    for (const c of ready) {
      const src = caseToTest(c);
      const asserts = c.expectations.flatMap((e) => e.asserts).length;
      const expects = (
        src.match(
          /\bawait expect\(|\bexpect\(res\.status\(\)|\bexpect\(await apiCount|\bawait expectPath\(|\bawait expectTextNear\(/g,
        ) ?? []
      ).length;
      assert.equal(expects, asserts, c.id);
    }
  });

  test('assertion kinds map to meaningful checks', () => {
    const auth = caseToTest(byId('DEMO-REQ-AUTH-003-002'));
    assert.match(
      auth,
      /await \(await actors\.request\('anonymous'\)\)\.fetch\('\/api\/requests', \{ method: 'GET' \}\);/,
    );
    assert.match(
      auth,
      /expect\(res\.status\(\), 'GET \/api\/requests as anonymous'\)\.toBe\(401\);/,
    );
    const reject = caseToTest(byId('DEMO-REQ-APP-002-002'));
    assert.match(
      reject,
      /fetch\(`\/api\/requests\/\$\{subject\.id\}\/reject`, \{ method: 'POST', data: \{ 'reason': '' \} \}\)/,
    );
    const rbac = caseToTest(byId('DEMO-REQ-APP-003-001'));
    assert.match(
      rbac,
      /getByRole\('button', \{ name: 'Approve', exact: true \}\)\)\.toHaveCount\(0\);/,
    );
    const create = caseToTest(byId('DEMO-REQ-REQ-001-001'));
    assert.match(create, /await expectTextNear\(requesterPage, data\.title, 'Pending'\);/);
    assert.match(create, /subject = subjectOf\(requesterPage\);/);
    const noCreate = caseToTest(byId('DEMO-REQ-REQ-002-001'));
    assert.match(
      noCreate,
      /let countBefore1 = 0;[\s\S]*countBefore1 = await apiCount[\s\S]*\.toBe\(countBefore1\);/,
    );
    const login = caseToTest(byId('DEMO-REQ-AUTH-002-001'));
    assert.match(login, /await actors\.login\('requester', \{ invalidPassword: true \}\);/);
    assert.match(login, /await expectPath\(requesterPage, '\/login'\);/);
  });

  test('every expectation step quotes its requirement line', () => {
    const src = caseToTest(byId('DEMO-REQ-APP-001-001'));
    assert.match(
      src,
      /test\.step\('expect: the request status is "Approved" \(docs\/requirements\.md:\d+\)'/,
    );
  });

  test('helpers: quoting, identifiers, paths, file names', () => {
    assert.equal(q("it's\\a\nb"), "'it\\'s\\\\a\\nb'");
    assert.equal(pageVar('requester'), 'requesterPage');
    assert.equal(pageVar('sales-admin'), 'salesAdminPage');
    assert.equal(pathExpr('/x'), "'/x'");
    assert.equal(pathExpr('{{subject.path}}'), 'subject.path');
    assert.equal(pathExpr('/api/r/{{subject.id}}/approve'), '`/api/r/${subject.id}/approve`');
    assert.throws(() => pathExpr('/x/{{other}}'), /unsupported placeholder/);
    assert.equal(specFileName('Access control'), 'access-control.spec.ts');
    assert.equal(specFileName(null), 'general.spec.ts');
  });

  test('fixtures template gets the project config and never credentials', () => {
    const config = parseProjectConfig(
      JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'examples/sample-app/.qa-agent/config.json'), 'utf8'),
      ),
      'c',
    );
    const src = fixturesSource(
      path.join(repoRoot, 'src/generator/runtime/qa-agent.fixtures.ts'),
      config,
    );
    assert.match(src, /projectId: "sample-approvals"/);
    assert.match(src, /"approver":"demo.approver"/);
    assert.match(src, /resetPath: "\/api\/test\/reset"/);
    assert.doesNotMatch(src, /-demo"/, 'no demo passwords');
    assert.throws(
      () => fixturesSource(path.join(repoRoot, 'package.json'), config),
      /no QA_AGENT_CONFIG block/,
    );
  });
});

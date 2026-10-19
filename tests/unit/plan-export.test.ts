import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { loadProjectConfig } from '../../src/config/project-config.schema.ts';
import { runDiscover } from '../../src/discovery/discover.ts';
import { planToCsv, planToMarkdown } from '../../src/planning/export.ts';
import { loadPlan, runPlan } from '../../src/planning/plan-stage.ts';
import { TestPlanSchema } from '../../src/planning/schema.ts';
import { copySampleApp } from '../helpers/sample-app.ts';

const temps: string[] = [];
after(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

function sampleCopy(): {
  root: string;
  config: NonNullable<ReturnType<typeof loadProjectConfig>>['config'];
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa plan export '));
  temps.push(root);
  copySampleApp(root);
  const loaded = loadProjectConfig(root);
  assert.ok(loaded);
  return { root, config: loaded.config };
}

describe('plan stage and exports', () => {
  test('writes versioned JSON, Markdown and CSV that agree with each other', async () => {
    const { root, config } = sampleCopy();
    await runDiscover({ projectRoot: root, config, tools: null });
    const { plan, files } = runPlan({
      projectRoot: root,
      config,
      now: () => new Date('2026-10-19T00:00:00Z'),
    });
    assert.deepEqual(
      files.map((f) => path.basename(f)),
      ['test-plan.json', 'test-plan.md', 'test-cases.csv'],
    );
    const reloaded = loadPlan(root);
    assert.deepEqual(reloaded, TestPlanSchema.parse(plan));
    assert.equal(reloaded.schemaVersion, 1);
    assert.equal(reloaded.inputs.projectMap, '.qa-agent/discovery/project-map.json');

    const md = fs.readFileSync(files[1] ?? '', 'utf8');
    for (const c of plan.cases) assert.ok(md.includes(`| ${c.id} | ${c.status} |`), c.id);
    assert.match(md, /"the request status is "Approved"" — docs\/requirements\.md:\d+/);
    assert.match(md, /## Needs review \/ blocked/);
    assert.match(md, /DEMO-REQ-REQ-004-001\*\* \(NEEDS_REVIEW\): no expected result is defined/);

    const csv = fs
      .readFileSync(files[2] ?? '', 'utf8')
      .trim()
      .split('\n');
    assert.equal(csv.length, plan.cases.length + 1);
    assert.equal(
      csv[0],
      'id,status,category,priority,riskScore,title,requirementRefs,dependencies,blockers',
    );
  });

  test('CSV escapes quotes and commas; Markdown escapes pipes', () => {
    const plan = TestPlanSchema.parse({
      schemaVersion: 1,
      projectId: 'x',
      generatedAt: 't',
      inputs: { requirementsFiles: [], projectMap: null },
      requirements: [],
      scenarios: [],
      cases: [
        {
          schemaVersion: 1,
          id: 'X-REQ-001-001',
          title: 'Says "hi", | pipes',
          feature: null,
          scenarioId: 'SCN-X',
          category: 'happy',
          priority: 'P2',
          riskScore: 0.21,
          status: 'NEEDS_REVIEW',
          requirementRefs: ['X-REQ-001'],
          actors: [],
          preconditions: [],
          setup: [],
          steps: [],
          expectations: [],
          dependencies: [],
          blockers: ['no expected result is defined in the requirement'],
          provenance: { requirementSources: [], mapRefs: [], generatedBy: 't' },
          automation: { specPath: null },
        },
      ],
      coverage: {
        requirements: 1,
        withReadyCases: 0,
        needsReview: [],
        categoriesNotRequired: [],
        unreferencedRoutes: [],
      },
      duplicatesMerged: [],
    });
    assert.match(planToCsv(plan), /"Says ""hi"", \| pipes"/);
    assert.match(planToMarkdown(plan), /Says "hi", \\\| pipes/);
  });

  test('invalid inputs: duplicate requirement ids, corrupt project map, missing plan', async () => {
    const { root, config } = sampleCopy();
    fs.appendFileSync(
      path.join(root, 'docs/requirements.md'),
      '\n### DEMO-REQ-AUTH-001 — Again\n- Expected: x\n',
    );
    assert.throws(
      () => runPlan({ projectRoot: root, config }),
      /DEMO-REQ-AUTH-001 is defined more than once/,
    );
    const other = sampleCopy();
    fs.mkdirSync(path.join(other.root, '.qa-agent/discovery'), { recursive: true });
    fs.writeFileSync(
      path.join(other.root, '.qa-agent/discovery/project-map.json'),
      '{"schemaVersion": 7}',
    );
    assert.throws(() => runPlan({ projectRoot: other.root, config: other.config }));
    assert.throws(() => loadPlan(sampleCopy().root), /test-plan\.json not found/);
  });
});

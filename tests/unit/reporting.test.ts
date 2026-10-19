import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { parseProjectConfig } from '../../src/config/project-config.schema.ts';
import { analyzeFailures } from '../../src/reporting/analyze.ts';
import { buildCoverage } from '../../src/reporting/coverage.ts';
import { cleanText, normalizeRun, secretValues } from '../../src/reporting/normalize.ts';
import {
  buildReport,
  reportToHtml,
  reportToMarkdown,
  runReport,
} from '../../src/reporting/report.ts';
import { TestPlanSchema } from '../../src/planning/schema.ts';
import type { RunRecord } from '../../src/orchestrator/run.ts';
import { repoRoot } from '../helpers/sample-app.ts';

const plan = TestPlanSchema.parse(
  JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/fixtures/sample-test-plan.json'), 'utf8')),
);
const config = parseProjectConfig(
  JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'examples/sample-app/.qa-agent/config.json'), 'utf8'),
  ),
  'cfg',
);
const temps: string[] = [];
after(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const ENV = {
  QA_AGENT_ACCOUNT_DEMO_REQUESTER_PASSWORD: 'p4ss-w0rd',
  QA_AGENT_ACCOUNT_DEMO_REQUESTER_USERNAME: 'alice',
};

const spec = (caseId: string, results: object[], status = 'expected') => ({
  title: `${caseId} ${plan.cases.find((c) => c.id === caseId)?.title ?? ''}`,
  tests: [{ projectName: 'chromium', status, results }],
});
const res = (status: string, extra: object = {}) => ({
  status,
  duration: 1000,
  workerIndex: 0,
  startTime: '2026-10-19T00:00:00.000Z',
  retry: 0,
  attachments: [],
  annotations: [],
  ...extra,
});

/** A run with one of each outcome; every other READY case is simply absent (NOT_RUN). */
function fakeRun(): { root: string; runId: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa report '));
  temps.push(root);
  const runId = 'run-test-0001';
  const runDir = path.join(root, 'qa-artifacts/runs', runId);
  fs.mkdirSync(path.join(runDir, 'inputs'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'inputs/test-plan.json'), JSON.stringify(plan));
  const record: RunRecord = {
    schemaVersion: 1,
    metadata: {
      qaAgentVersion: '0.1.0',
      node: 'v22',
      platform: 'test',
      playwrightVersion: '1.63.0',
      browser: 'chromium',
      buildId: 'git:abc123',
      environment: 'local',
    },
    runId,
    projectId: 'sample-approvals',
    startedAt: 't0',
    finishedAt: 't1',
    baseURL: 'http://127.0.0.1:4100/',
    schedule: {
      schemaVersion: 1,
      cases: [],
      levels: [],
      parallel: [],
      serial: [],
      workers: { parallel: 1, serial: 1 },
      rationale: [],
    },
    phases: [
      {
        name: 'parallel',
        workers: 1,
        grep: '',
        cases: 6,
        exitCode: 1,
        resultsFile: `qa-artifacts/runs/${runId}/results-parallel.json`,
        durationMs: 1,
      },
    ],
    exitCode: 1,
  };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(record));
  const trace = path.join(runDir, 'test-results-parallel/x/trace.zip');
  const report = {
    suites: [
      {
        suites: [
          {
            specs: [
              spec('DEMO-REQ-REQ-001-001', [res('passed')]),
              spec(
                'DEMO-REQ-APP-003-002',
                [
                  res('failed', {
                    error: {
                      message:
                        '\u001b[31mError: POST /api/requests/REQ-9/approve as requester\nExpected: 403\nReceived: 200\u001b[39m',
                      location: {
                        file: path.join(root, 'e2e/generated/approval.spec.ts'),
                        line: 199,
                        column: 90,
                      },
                    },
                    attachments: [{ name: 'trace', contentType: 'application/zip', path: trace }],
                  }),
                ],
                'unexpected',
              ),
              spec(
                'DEMO-REQ-AUTH-001-001',
                [
                  res('failed', {
                    error: {
                      message:
                        'Error: QA_AGENT_BLOCKED: missing QA_AGENT_ACCOUNT_DEMO_REQUESTER_USERNAME',
                    },
                  }),
                ],
                'unexpected',
              ),
              spec('DEMO-REQ-AUTH-002-001', [res('interrupted')], 'skipped'),
              spec('DEMO-REQ-AUTH-003-001', [res('skipped')], 'skipped'),
              spec(
                'DEMO-REQ-AUTH-003-002',
                [res('failed', { error: { message: 'Error: timeout' } }), res('passed')],
                'flaky',
              ),
              spec(
                'DEMO-REQ-REQ-002-001',
                [
                  res('failed', {
                    error: {
                      message:
                        'Error: typed p4ss-w0rd then strict mode violation: getByRole(...) resolved to 2 elements',
                    },
                  }),
                ],
                'unexpected',
              ),
              {
                title: 'custom spec not in the plan',
                tests: [{ status: 'expected', results: [res('passed')] }],
              },
            ],
          },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(runDir, 'results-parallel.json'), JSON.stringify(report));
  return { root, runId };
}

describe('normalisation', () => {
  const { root, runId } = fakeRun();
  const record = JSON.parse(
    fs.readFileSync(path.join(root, 'qa-artifacts/runs', runId, 'run.json'), 'utf8'),
  ) as RunRecord;
  const results = normalizeRun({ projectRoot: root, record, plan, env: ENV });
  const by = (id: string) => results.find((r) => r.caseId === id);

  test('one result per plan case with the QA Agent status', () => {
    assert.equal(results.length, plan.cases.length);
    assert.equal(by('DEMO-REQ-REQ-001-001')?.status, 'PASS');
    assert.equal(by('DEMO-REQ-APP-003-002')?.status, 'FAIL');
    assert.equal(by('DEMO-REQ-AUTH-001-001')?.status, 'BLOCKED');
    assert.equal(by('DEMO-REQ-AUTH-002-001')?.status, 'NOT_RUN');
    assert.equal(by('DEMO-REQ-AUTH-003-001')?.status, 'SKIPPED');
    assert.deepEqual(
      [
        by('DEMO-REQ-AUTH-003-002')?.status,
        by('DEMO-REQ-AUTH-003-002')?.flaky,
        by('DEMO-REQ-AUTH-003-002')?.attempts,
      ],
      ['PASS', true, 2],
    );
    assert.equal(by('DEMO-REQ-APP-001-001')?.note, 'READY but not executed in this run');
    assert.match(by('DEMO-REQ-REQ-004-001')?.note ?? '', /plan status NEEDS_REVIEW/);
    assert.equal(by('DEMO-REQ-REQ-004-001')?.status, 'NOT_RUN');
  });

  test('case metadata, project-relative paths, ANSI stripped, secrets masked', () => {
    const f = by('DEMO-REQ-APP-003-002');
    assert.deepEqual(
      [f?.browser, f?.buildId, f?.requirementRefs, f?.error?.location],
      ['chromium', 'git:abc123', ['DEMO-REQ-APP-003'], 'e2e/generated/approval.spec.ts:199:90'],
    );
    assert.ok(!(f?.error?.message ?? '').includes('\u001b'), 'ANSI escape codes are stripped');
    assert.match(
      f?.attachments[0]?.path ?? '',
      /^qa-artifacts\/runs\/run-test-0001\/test-results-parallel\/x\/trace\.zip$/,
    );
    assert.match(by('DEMO-REQ-REQ-002-001')?.error?.message ?? '', /typed \*\*\* then/);
    assert.ok(!JSON.stringify(results).includes('p4ss-w0rd'));
    assert.deepEqual(
      secretValues({
        QA_AGENT_ACCOUNT_X_PASSWORD: 'abc',
        QA_AGENT_ACCOUNT_X_USERNAME: 'u',
        OTHER: 'z',
      }),
      ['abc'],
    );
    assert.equal(cleanText('\u001b[31mred\u001b[39m abc', ['abc']), 'red ***');
  });

  test('failure analysis: classification, confidence and evidence', () => {
    const analyses = analyzeFailures(results, plan);
    const a = (id: string) => analyses.find((x) => x.caseId === id);
    assert.deepEqual(
      [a('DEMO-REQ-APP-003-002')?.classification, a('DEMO-REQ-APP-003-002')?.confidence],
      ['probable_app_bug', 0.85],
    );
    assert.ok(
      a('DEMO-REQ-APP-003-002')?.evidence.some((e) =>
        /docs\/requirements\.md:\d+.*returns HTTP 403/.test(e),
      ),
    );
    assert.ok(
      a('DEMO-REQ-APP-003-002')?.evidence.some((e) => e.startsWith('trace: qa-artifacts/')),
    );
    assert.equal(a('DEMO-REQ-AUTH-001-001')?.classification, 'environment_issue');
    assert.equal(a('DEMO-REQ-REQ-002-001')?.classification, 'test_automation_issue');
    assert.equal(a('DEMO-REQ-AUTH-003-002'), undefined, 'a flaky pass is not a failure');
    assert.equal(analyses.length, 3);
  });

  test('coverage keeps generated / ready / executed / passed apart', () => {
    const cov = buildCoverage(plan, results);
    assert.deepEqual(cov.counts, {
      generated: 22,
      ready: 20,
      executed: 5,
      passed: 2,
      failed: 2,
      blocked: 1,
      skipped: 1,
      notRun: 16,
      flaky: 1,
    });
    assert.equal(cov.rows.find((r) => r.id === 'DEMO-REQ-APP-003')?.verdict, 'failing');
    assert.equal(cov.rows.find((r) => r.id === 'DEMO-REQ-REQ-004')?.verdict, 'needs-review');
    assert.equal(cov.requirementCoverage, Math.round((11 / 12) * 1000) / 1000);
  });
});

describe('interrupted runs', () => {
  test('a test cut off by --global-timeout is NOT_RUN; a deliberate skip stays SKIPPED', () => {
    const { root, runId } = fakeRun();
    const file = path.join(root, 'qa-artifacts/runs', runId, 'results-parallel.json');
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    report.errors = [{ message: 'Timed out waiting 45s for the test suite to run' }];
    report.suites[0].suites[0].specs.push(
      spec(
        'DEMO-REQ-REQ-003-001',
        [res('skipped', { annotations: [{ type: 'skip' }] })],
        'skipped',
      ),
    );
    fs.writeFileSync(file, JSON.stringify(report));
    const record = JSON.parse(
      fs.readFileSync(path.join(root, 'qa-artifacts/runs', runId, 'run.json'), 'utf8'),
    ) as RunRecord;
    const results = normalizeRun({ projectRoot: root, record, plan, env: ENV });
    assert.equal(results.find((r) => r.caseId === 'DEMO-REQ-AUTH-003-001')?.status, 'NOT_RUN');
    assert.equal(results.find((r) => r.caseId === 'DEMO-REQ-REQ-003-001')?.status, 'SKIPPED');
  });
});

describe('report files', () => {
  test('JSON, Markdown and HTML agree; AI analysis is merged only when valid and for failing cases', () => {
    const { root, runId } = fakeRun();
    const runDir = path.join(root, 'qa-artifacts/runs', runId);
    fs.writeFileSync(
      path.join(runDir, 'ai-analysis.json'),
      JSON.stringify([
        {
          caseId: 'DEMO-REQ-APP-003-002',
          classification: 'probable_app_bug',
          confidence: 0.9,
          rationale: 'Requester got 200 where 403 is required.',
          evidence: ['docs/requirements.md:116'],
        },
        {
          caseId: 'DEMO-REQ-REQ-001-001',
          classification: 'probable_app_bug',
          confidence: 0.9,
          rationale: 'This case passed, so this is ignored.',
          evidence: ['x'],
        },
      ]),
    );
    const { report, files } = runReport({ projectRoot: root, config, runId, env: ENV });
    assert.equal(files.length, 3);
    assert.ok(
      report.analyses.some((a) => a.source === 'ai' && a.caseId === 'DEMO-REQ-APP-003-002'),
    );
    assert.match(report.aiNotes.join(), /DEMO-REQ-REQ-001-001 ignored: the case did not fail/);
    const md = fs.readFileSync(path.join(runDir, 'report/summary.md'), 'utf8');
    assert.match(md, /## Executive summary/);
    assert.match(md, /2 failed, 1 blocked, \d+ runnable case\(s\) not run/);
    assert.match(md, /\| DEMO-REQ-APP-003-002 \| FAIL \| probable_app_bug \| 0\.9 \| ai \|/);
    assert.ok(
      !md.includes('p4ss-w0rd') &&
        !fs.readFileSync(path.join(runDir, 'report/report.html'), 'utf8').includes('p4ss-w0rd'),
    );

    fs.writeFileSync(
      path.join(runDir, 'ai-analysis.json'),
      JSON.stringify([{ caseId: 'X', classification: 'magic' }]),
    );
    assert.match(
      buildReport({ projectRoot: root, runId, env: ENV }).aiNotes.join(),
      /ai-analysis\.json ignored/,
    );
  });

  test('HTML escapes page-controlled text', () => {
    const { root, runId } = fakeRun();
    const report = buildReport({ projectRoot: root, runId, env: ENV });
    const first = report.results[0];
    assert.ok(first);
    first.title = '<script>alert(1)</script>';
    const html = reportToHtml(report, path.join(root, 'r'), root);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.match(reportToMarkdown(report), /# QA report — sample-approvals — run-test-0001/);
  });
});

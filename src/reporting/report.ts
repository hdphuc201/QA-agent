// `report` stage: run record + plan → qa-artifacts/runs/<runId>/report/{results.json, summary.md,
// report.html}. Playwright decides PASS/FAIL; analyses (rules, optional AI) only explain failures.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ProjectConfig } from '../config/project-config.schema.ts';
import { writeProjectFile } from '../config/write-guard.ts';
import { RUNS_DIR, type RunRecord } from '../orchestrator/run.ts';
import { TestPlanSchema, type TestPlan } from '../planning/schema.ts';
import { analyzeFailures, type FailureAnalysis } from './analyze.ts';
import { buildCoverage, type CoverageSummary } from './coverage.ts';
import { cleanText, normalizeRun, secretValues, type NormalizedResult } from './normalize.ts';

export const REPORT_SCHEMA_VERSION = 1;

/** Shape of the optional AI second opinion written by the failure-analyzer agent. */
export const AiAnalysisSchema = z.array(
  z.strictObject({
    caseId: z.string(),
    classification: z.enum([
      'probable_app_bug',
      'test_automation_issue',
      'environment_issue',
      'insufficient_evidence',
    ]),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(10),
    evidence: z.array(z.string()).min(1),
  }),
);

export interface QaReport {
  schemaVersion: number;
  runId: string;
  projectId: string;
  generatedAt: string;
  run: Pick<RunRecord, 'startedAt' | 'finishedAt' | 'baseURL' | 'metadata' | 'exitCode'> & {
    phases: RunRecord['phases'];
  };
  results: NormalizedResult[];
  analyses: FailureAnalysis[];
  aiNotes: string[];
  coverage: CoverageSummary;
  links: { playwrightHtml: string[]; runRecord: string };
}

export function latestRunId(projectRoot: string): string | null {
  const dir = path.join(projectRoot, RUNS_DIR);
  if (!fs.existsSync(dir)) return null;
  return (
    fs
      .readdirSync(dir)
      .filter((d) => fs.existsSync(path.join(dir, d, 'run.json')))
      .sort()
      .at(-1) ?? null
  );
}

export function buildReport(options: {
  projectRoot: string;
  runId: string;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}): QaReport {
  const { projectRoot, runId } = options;
  const runDir = path.join(projectRoot, RUNS_DIR, runId);
  const record = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')) as RunRecord;
  // The plan the run actually used (frozen in inputs/), falling back to the current plan.
  const planFile = [
    path.join(runDir, 'inputs/test-plan.json'),
    path.join(projectRoot, '.qa-agent/plan/test-plan.json'),
  ].find((f) => fs.existsSync(f));
  if (!planFile) throw new Error('no test plan found for this run');
  const plan: TestPlan = TestPlanSchema.parse(JSON.parse(fs.readFileSync(planFile, 'utf8')));
  const results = normalizeRun({
    projectRoot,
    record,
    plan,
    ...(options.env ? { env: options.env } : {}),
  });
  const analyses = analyzeFailures(results, plan);

  const aiNotes: string[] = [];
  const aiFile = path.join(runDir, 'ai-analysis.json');
  if (fs.existsSync(aiFile)) {
    const parsed = AiAnalysisSchema.safeParse(JSON.parse(fs.readFileSync(aiFile, 'utf8')));
    if (!parsed.success)
      aiNotes.push(
        `ai-analysis.json ignored: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    else {
      const failing = new Set(analyses.map((a) => a.caseId));
      for (const a of parsed.data) {
        if (!failing.has(a.caseId))
          aiNotes.push(`AI analysis for ${a.caseId} ignored: the case did not fail or was blocked`);
        else analyses.push({ ...a, source: 'ai' });
      }
    }
  }
  const secrets = secretValues(options.env ?? process.env);
  for (const a of analyses) a.evidence = a.evidence.map((e) => cleanText(e, secrets));

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId,
    projectId: record.projectId,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    run: {
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      baseURL: record.baseURL,
      metadata: record.metadata,
      exitCode: record.exitCode,
      phases: record.phases,
    },
    results,
    analyses,
    aiNotes,
    coverage: buildCoverage(plan, results),
    links: {
      playwrightHtml: record.phases
        .map((p) => `${RUNS_DIR}/${runId}/html-${p.name}/index.html`)
        .filter((p) => fs.existsSync(path.join(projectRoot, p))),
      runRecord: `${RUNS_DIR}/${runId}/run.json`,
    },
  };
}

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
/** " (chromium PASS, firefox FAIL)" when a case ran in more than one browser. */
const perBrowser = (x: NormalizedResult) => {
  const e = Object.entries(x.byBrowser ?? {});
  return e.length > 1 ? ` (${e.map(([b, s]) => `${b} ${s}`).join(', ')})` : '';
};

export function reportToMarkdown(r: QaReport): string {
  const c = r.coverage.counts;
  // READY cases that did not execute (interrupted run, filtered out) count against "all passed".
  const readyNotRun = r.results.filter(
    (x) => x.status === 'NOT_RUN' && !x.note?.startsWith('plan status'),
  ).length;
  const verdict =
    c.failed === 0 && c.blocked === 0 && readyNotRun === 0
      ? 'every runnable case passed'
      : `${c.failed} failed, ${c.blocked} blocked, ${readyNotRun} runnable case(s) not run`;
  const lines = [
    `# QA report — ${r.projectId} — ${r.runId}`,
    '',
    '## Executive summary',
    '',
    `- **Result:** ${verdict}. Passed ${c.passed} / executed ${c.executed} (ready ${c.ready}, generated ${c.generated}); skipped ${c.skipped}, not run ${c.notRun}, flaky ${c.flaky}.`,
    `- **Requirements:** ${r.coverage.requirements} in scope; ${r.coverage.withReadyCases} with runnable cases (requirement coverage ${(r.coverage.requirementCoverage * 100).toFixed(0)}%); ${r.coverage.fullyPassing} fully passing.`,
    `- **Run:** ${r.run.startedAt} → ${r.run.finishedAt} on ${r.run.baseURL} (${r.run.metadata.environment}); build ${r.run.metadata.buildId}; ${r.run.metadata.browser}; Playwright ${r.run.metadata.playwrightVersion ?? '?'}; QA Agent ${r.run.metadata.qaAgentVersion}.`,
    `- PASS/FAIL comes from Playwright assertions. Failure classifications are explanations with a confidence, not verdicts.`,
    '',
  ];
  if (r.analyses.length) {
    lines.push(
      '## Failures and blocked cases',
      '',
      '| Case | Status | Classification | Confidence | Source | Rationale |',
      '|---|---|---|---|---|---|',
    );
    for (const a of r.analyses) {
      const res = r.results.find((x) => x.caseId === a.caseId);
      lines.push(
        `| ${a.caseId} | ${res?.status ?? '?'} | ${a.classification} | ${a.confidence} | ${a.source} | ${md(a.rationale)} |`,
      );
    }
    lines.push('');
    for (const a of r.analyses.filter((x) => x.source === 'rules')) {
      lines.push(`### ${a.caseId}`, '', ...a.evidence.map((e) => `- ${md(e)}`), '');
    }
  }
  lines.push(
    '## Requirement coverage',
    '',
    '| Requirement | Priority | Verdict | Cases |',
    '|---|---|---|---|',
  );
  for (const row of r.coverage.rows) {
    lines.push(
      `| ${row.id} — ${md(row.title)} | ${row.priority} | ${row.verdict} | ${row.cases.map((x) => `${x.id} ${x.result}${x.planStatus !== 'READY' ? ` (${x.planStatus})` : ''}`).join(', ') || '—'} |`,
    );
  }
  lines.push(
    '',
    '## All cases',
    '',
    '| Case | Status | Category | Priority | Duration | Phase | Requirements |',
    '|---|---|---|---|---|---|---|',
  );
  for (const x of r.results) {
    lines.push(
      `| ${x.caseId} | ${x.status}${x.flaky ? ' (flaky)' : ''}${perBrowser(x)} | ${x.category} | ${x.priority} | ${(x.durationMs / 1000).toFixed(1)}s | ${x.phase ?? '—'} | ${x.requirementRefs.join(', ')} |`,
    );
  }
  const notRun = r.results.filter((x) => x.note);
  if (notRun.length)
    lines.push(
      '',
      '## Not run / blocked by the plan',
      '',
      ...notRun.map((x) => `- ${x.caseId}: ${md(x.note ?? '')}`),
    );
  if (r.aiNotes.length)
    lines.push('', '## AI analysis notes', '', ...r.aiNotes.map((n) => `- ${md(n)}`));
  lines.push(
    '',
    '## Artifacts',
    '',
    `- Run record: \`${r.links.runRecord}\``,
    ...r.links.playwrightHtml.map((p) => `- Playwright HTML report: \`${p}\``),
    '- Traces and screenshots of failed tests are listed per failure. **They can contain session data and typed values; do not share them outside the team.**',
    '',
  );
  return lines.join('\n');
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );

export function reportToHtml(r: QaReport, reportDir: string, projectRoot: string): string {
  const link = (p: string) =>
    esc(path.relative(reportDir, path.join(projectRoot, p)).split(path.sep).join('/'));
  const c = r.coverage.counts;
  const badge = (s: string) => `<span class="b ${esc(s.toLowerCase())}">${esc(s)}</span>`;
  const rows = r.results
    .map((x) => {
      const a = r.analyses.filter((y) => y.caseId === x.caseId);
      const atts = x.attachments
        .map((t) => `<a href="${link(t.path)}">${esc(t.name)}</a>`)
        .join(' ');
      return `<tr><td>${esc(x.caseId)}</td><td>${badge(x.status)}${x.flaky ? ' flaky' : ''}${esc(perBrowser(x))}</td><td>${esc(x.title)}</td><td>${esc(x.requirementRefs.join(', '))}</td><td>${esc(x.category)}</td><td>${(x.durationMs / 1000).toFixed(1)}s</td><td>${a.map((y) => `${esc(y.classification)} (${y.confidence}, ${y.source})`).join('<br>')}${x.error ? `<details><summary>error</summary><pre>${esc(x.error.message)}</pre></details>` : ''}${x.note ? `<small>${esc(x.note)}</small>` : ''}</td><td>${atts}</td></tr>`;
    })
    .join('\n');
  const cov = r.coverage.rows
    .map(
      (row) =>
        `<tr><td>${esc(row.id)}</td><td>${esc(row.title)}</td><td>${badge(row.verdict)}</td><td>${esc(row.cases.map((x) => `${x.id} ${x.result}`).join(', '))}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>QA report ${esc(r.runId)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1b1f24;background:#fff}
table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #d0d7de;padding:6px;vertical-align:top;text-align:left}
th{background:#f6f8fa}.b{padding:1px 6px;border-radius:8px;font-weight:600;font-size:12px}
.pass,.passing{background:#dafbe1;color:#116329}.fail,.failing{background:#ffebe9;color:#a40e26}
.blocked,.needs-review{background:#fff8c5;color:#7d4e00}.not_run,.not-run,.skipped,.no-cases{background:#eaeef2;color:#424a53}
pre{white-space:pre-wrap;font-size:12px}small{display:block;color:#57606a}
@media (prefers-color-scheme: dark){body{background:#0d1117;color:#e6edf3}th{background:#161b22}td,th{border-color:#30363d}}
</style></head><body>
<h1>QA report — ${esc(r.projectId)}</h1>
<p>Run <code>${esc(r.runId)}</code> · ${esc(r.run.startedAt)} → ${esc(r.run.finishedAt)} · ${esc(r.run.baseURL)} (${esc(r.run.metadata.environment)}) · build ${esc(r.run.metadata.buildId)} · ${esc(r.run.metadata.browser)}</p>
<p><b>Passed ${c.passed}</b> / executed ${c.executed} · failed ${c.failed} · blocked ${c.blocked} · skipped ${c.skipped} · not run ${c.notRun} · flaky ${c.flaky} · generated ${c.generated}, ready ${c.ready} · requirement coverage ${(r.coverage.requirementCoverage * 100).toFixed(0)}%</p>
<p>PASS/FAIL comes from Playwright assertions; classifications explain failures and carry a confidence. ${r.links.playwrightHtml.map((p) => `<a href="${link(p)}">Playwright report</a>`).join(' · ')}</p>
<h2>Cases</h2><table><tr><th>Case</th><th>Status</th><th>Title</th><th>Requirements</th><th>Category</th><th>Duration</th><th>Analysis</th><th>Evidence</th></tr>
${rows}
</table>
<h2>Requirement coverage</h2><table><tr><th>Requirement</th><th>Title</th><th>Verdict</th><th>Cases</th></tr>
${cov}
</table>
<p><small>Traces and screenshots may contain session data and typed values; keep them inside the team.</small></p>
</body></html>
`;
}

export function runReport(options: {
  projectRoot: string;
  config: ProjectConfig;
  runId?: string;
  env?: Readonly<Record<string, string | undefined>>;
}): { report: QaReport; files: string[] } {
  const runId = options.runId ?? latestRunId(options.projectRoot);
  if (!runId) throw new Error('no run found under qa-artifacts/runs — run "run" first');
  const report = buildReport({
    projectRoot: options.projectRoot,
    runId,
    ...(options.env ? { env: options.env } : {}),
  });
  const dir = `${RUNS_DIR}/${runId}/report`;
  const abs = path.join(options.projectRoot, dir);
  const files = [
    writeProjectFile(
      options.projectRoot,
      options.config,
      `${dir}/results.json`,
      `${JSON.stringify(report, null, 2)}\n`,
    ),
    writeProjectFile(
      options.projectRoot,
      options.config,
      `${dir}/summary.md`,
      reportToMarkdown(report),
    ),
    writeProjectFile(
      options.projectRoot,
      options.config,
      `${dir}/report.html`,
      reportToHtml(report, abs, options.projectRoot),
    ),
  ];
  return { report, files };
}

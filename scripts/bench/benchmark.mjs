#!/usr/bin/env node
// P8-T05 benchmark: stage runtimes (live exploration vs deterministic regression), engine memory,
// sampled system memory, flaky rate over repeated regression runs, and the worker budget effect.
// Token cost is not measured here (the engine uses no model); it is read from the redacted
// in-Claude smoke transcripts in evidence/.
//
//   node --experimental-strip-types scripts/bench/benchmark.mjs [--runs 3] [--skip-live] [--out evidence/P8]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startSampleApp } from '../../examples/sample-app/server.mjs';
import { startHelpdeskApp } from '../../examples/helpdesk-app/server.mjs';
import { parseProjectConfig } from '../../src/config/project-config.schema.ts';
import { runDiscover } from '../../src/discovery/discover.ts';
import { startPlaywrightTools } from '../../src/discovery/explorer.ts';
import { runGenerate } from '../../src/generator/generate.ts';
import { validateGenerated } from '../../src/generator/validate.ts';
import { runSuite } from '../../src/orchestrator/run.ts';
import { runPlan } from '../../src/planning/plan-stage.ts';
import { runReport } from '../../src/reporting/report.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    'skip-live': { type: 'boolean', default: false },
    out: { type: 'string', default: 'evidence/P8' },
  },
});
const RUNS = Number(args.runs);

const APPS = [
  {
    name: 'sample-app',
    start: () => startSampleApp({ env: { SAMPLE_APP_TEST_MODE: '1' } }),
    accounts: {
      DEMO_REQUESTER: ['alice', 'alice-demo'],
      DEMO_APPROVER: ['bob', 'bob-demo'],
      DEMO_VIEWER: ['victor', 'victor-demo'],
    },
  },
  {
    name: 'helpdesk-app',
    start: () => startHelpdeskApp({ env: { HELPDESK_TEST_MODE: '1' } }),
    accounts: {
      HELPDESK_CUSTOMER: ['carol@helpdesk.test', 'carol-helpdesk'],
      HELPDESK_AGENT: ['dan@helpdesk.test', 'dan-helpdesk'],
      HELPDESK_AUDITOR: ['erin@helpdesk.test', 'erin-helpdesk'],
    },
  },
];

const GENERATED =
  /[\\/](e2e|tests[\\/]qa|qa-artifacts|node_modules)([\\/]|$)|[\\/]\.qa-agent[\\/](?!config\.json$)/;

/** Peak of (used system memory - baseline) while `fn` runs, sampled every 250 ms. */
/** @template T @param {() => Promise<T>} fn */
async function withMemory(fn) {
  const used = () => os.totalmem() - os.freemem();
  const base = used();
  let peak = base;
  const timer = setInterval(() => (peak = Math.max(peak, used())), 250);
  const t0 = performance.now();
  try {
    const value = await fn();
    return {
      value,
      ms: Math.round(performance.now() - t0),
      sysPeakMB: Math.round((peak - base) / 2 ** 20),
    };
  } finally {
    clearInterval(timer);
  }
}

/** @param {string} root @param {string} runId */
function countsOf(root, runId) {
  /** @type {{ coverage: { counts: Record<string, number> }, results: { flaky: boolean, status: string, caseId: string }[] }} */
  const r = JSON.parse(
    fs.readFileSync(path.join(root, 'qa-artifacts/runs', runId, 'report/results.json'), 'utf8'),
  );
  return {
    ...r.coverage.counts,
    flaky: r.results.filter((x) => x.flaky).length,
    failed: r.results.filter((x) => x.status === 'FAIL').map((x) => x.caseId),
  };
}

/** @param {(typeof APPS)[number]} app */
async function benchApp(app) {
  const server = await app.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `qa bench ${app.name} `));
  const src = path.join(repoRoot, 'examples', app.name);
  fs.cpSync(src, root, {
    recursive: true,
    filter: (s) => !GENERATED.test(path.sep + path.relative(src, s)),
  });
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"bench-target","private":true}\n');
  const raw = JSON.parse(fs.readFileSync(path.join(root, '.qa-agent/config.json'), 'utf8'));
  raw.baseURL = `${server.url}/`;
  raw.allowedOrigins = [server.url];
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    FORCE_COLOR: '0',
    QA_AGENT_BROWSER_CHANNEL: process.env.QA_AGENT_BROWSER_CHANNEL ?? 'chrome',
  };
  for (const [k, [u, p]] of Object.entries(app.accounts)) {
    env[`QA_AGENT_ACCOUNT_${k}_USERNAME`] = u;
    env[`QA_AGENT_ACCOUNT_${k}_PASSWORD`] = p;
  }
  /** @type {{ app: string, stages: Record<string, any>, regression: any[] }} */
  const out = { app: app.name, stages: {}, regression: [] };
  try {
    const config = parseProjectConfig(raw, 'cfg');
    const live = !args['skip-live'];
    const d = await withMemory(async () =>
      runDiscover({
        projectRoot: root,
        config,
        env,
        tools: live
          ? await startPlaywrightTools({ pluginRoot: repoRoot, projectRoot: root, config })
          : null,
      }),
    );
    out.stages.discover = {
      live,
      ms: d.ms,
      sysPeakMB: d.sysPeakMB,
      observedPages: d.value.map.exploration.pages,
      routes: d.value.map.routes.length,
    };
    const p = await withMemory(async () => runPlan({ projectRoot: root, config }));
    const plan = p.value.plan;
    out.stages.plan = {
      ms: p.ms,
      cases: plan.cases.length,
      ready: plan.cases.filter((c) => c.status === 'READY').length,
    };
    const g = await withMemory(async () => {
      const res = await runGenerate({
        projectRoot: root,
        config,
        plan,
        runtimeFile: path.join(repoRoot, 'src/generator/runtime/qa-agent.fixtures.ts'),
      });
      return {
        res,
        v: validateGenerated({
          projectRoot: root,
          outputRoot: config.testOutputRoot,
          pluginRoot: repoRoot,
          expected: res.cases.length,
        }),
      };
    });
    out.stages.generateAndValidate = {
      ms: g.ms,
      tests: g.value.res.cases.length,
      valid: g.value.v.ok,
    };
    for (const max of [1, 2]) {
      const cfg = parseProjectConfig({ ...raw, workers: { max, writeHeavy: 1 } }, 'cfg');
      for (let i = 1; i <= RUNS; i++) {
        const r = await withMemory(async () =>
          runSuite({ projectRoot: root, config: cfg, plan, env, out: () => undefined }),
        );
        runReport({ projectRoot: root, config: cfg, runId: r.value.runId, env });
        out.regression.push({
          workers: max,
          run: i,
          ms: r.ms,
          sysPeakMB: r.sysPeakMB,
          exitCode: r.value.exitCode,
          ...countsOf(root, r.value.runId),
        });
        process.stdout.write(
          `${app.name} workers=${max} run ${i}: ${r.ms} ms exit=${r.value.exitCode}\n`,
        );
      }
    }
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  return out;
}

/** Token usage of the in-Claude smokes (final `result` event of each redacted transcript). */
function tokenUsage() {
  const files = {
    'plugin smoke (P1, skill discovery + 1 MCP call)': 'evidence/P1/claude-plugin-smoke.jsonl',
    'full-test in Claude, run 1 (P7, no failure analysis)':
      'evidence/P7/claude-fulltest-smoke-run1.jsonl',
    'full-test in Claude, run 2 (P7, with failure-analyzer subagent)':
      'evidence/P7/claude-fulltest-smoke.jsonl',
  };
  return Object.entries(files).flatMap(([label, rel]) => {
    const file = path.join(repoRoot, rel);
    if (!fs.existsSync(file)) return [];
    const events = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
    const r = events.filter((e) => e.type === 'result').at(-1);
    if (!r) return [];
    const u = r.usage ?? {};
    return [
      {
        label,
        source: rel,
        model: Object.keys(r.modelUsage ?? {}).join(', '),
        costUsd: r.total_cost_usd,
        turns: r.num_turns,
        durationMs: r.duration_ms,
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens,
        cacheWriteTokens: u.cache_creation_input_tokens,
      },
    ];
  });
}

const t0 = Date.now();
const apps = [];
for (const app of APPS) apps.push(await benchApp(app));
const engineMaxRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
const result = {
  generatedAt: new Date().toISOString(),
  machine: {
    platform: `${process.platform} ${process.arch}`,
    cpus: os.cpus().length,
    totalMemGB: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
  },
  runsPerWorkerSetting: RUNS,
  engineMaxRssMB,
  apps,
  tokens: tokenUsage(),
  totalMs: Date.now() - t0,
};

const outDir = path.resolve(repoRoot, args.out);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'benchmark.json'), `${JSON.stringify(result, null, 2)}\n`);

const median = (/** @type {number[]} */ xs) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const md = [
  `# QA Agent benchmark (${result.generatedAt})`,
  '',
  `Machine: ${result.machine.platform}, ${result.machine.cpus} CPUs, ${result.machine.totalMemGB} GB, Node ${result.machine.node}. Engine peak RSS (whole benchmark process): ${engineMaxRssMB} MB. "sys peak" = peak growth of used system memory during the step (browsers included; noisy).`,
  '',
  '## Stages (first pass)',
  '',
  '| App | Discover | Plan | Generate + validate |',
  '| --- | --- | --- | --- |',
  ...apps.map(
    (a) =>
      `| ${a.app} | ${(a.stages.discover.ms / 1000).toFixed(1)}s (${a.stages.discover.live ? `live, ${a.stages.discover.observedPages} pages` : 'static'}, sys peak ${a.stages.discover.sysPeakMB} MB) | ${a.stages.plan.ms} ms (${a.stages.plan.ready}/${a.stages.plan.cases} READY) | ${(a.stages.generateAndValidate.ms / 1000).toFixed(1)}s (${a.stages.generateAndValidate.tests} tests, valid ${a.stages.generateAndValidate.valid}) |`,
  ),
  '',
  `## Regression runs (${RUNS} per worker setting)`,
  '',
  '| App | Workers (isolated phase) | Median wall time | Min–max | Sys peak (max) | Passed (each run) | Failed runs | Flaky |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...apps.flatMap((a) =>
    [1, 2].map((w) => {
      const rs = a.regression.filter((r) => r.workers === w);
      const ms = rs.map((r) => r.ms);
      return `| ${a.app} | ${w} | ${(median(ms) / 1000).toFixed(1)}s | ${(Math.min(...ms) / 1000).toFixed(1)}–${(Math.max(...ms) / 1000).toFixed(1)}s | ${Math.max(...rs.map((r) => r.sysPeakMB))} MB | ${rs.map((r) => `${r.passed}/${r.executed}`).join(', ')} | ${rs.filter((r) => r.failed.length).length} | ${rs.reduce((n, r) => n + r.flaky, 0)} |`;
    }),
  ),
  '',
  '## Token consumption (model use happens only in Claude sessions; the engine itself uses none)',
  '',
  '| Session | Model | Cost (USD) | Turns | Duration | Output tokens | Cache read | Cache write |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...result.tokens.map(
    (t) =>
      `| ${t.label} | ${t.model} | ${t.costUsd?.toFixed(2)} | ${t.turns} | ${(t.durationMs / 1000).toFixed(0)}s | ${t.outputTokens} | ${t.cacheReadTokens} | ${t.cacheWriteTokens} |`,
  ),
  '',
];
fs.writeFileSync(path.join(outDir, 'benchmark.md'), md.join('\n'));
process.stdout.write(
  `${md.join('\n')}\nwrote ${path.relative(repoRoot, outDir)}/benchmark.{json,md}\n`,
);

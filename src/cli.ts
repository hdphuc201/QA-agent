#!/usr/bin/env node
// QA Agent engine CLI (deterministic; the plugin skills call it).
//   node --experimental-strip-types src/cli.ts <command> [--project <dir>] [options]
// Exit codes: 0 ok · 1 stage failed / blocked · 2 usage · 3 config or IO error.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, resolvePluginRoot, resolveProjectRoot } from './config/paths.ts';
import { loadProjectConfig, type ProjectConfig } from './config/project-config.schema.ts';
import { assertEnvironmentAllowed, PolicyError } from './config/policy.ts';
import { WriteDeniedError } from './config/write-guard.ts';
import { runDiscover } from './discovery/discover.ts';
import { startPlaywrightTools } from './discovery/explorer.ts';
import { runGenerate } from './generator/generate.ts';
import { validateGenerated } from './generator/validate.ts';
import { runFullTest } from './orchestrator/full-test.ts';
import { runSuite } from './orchestrator/run.ts';
import { runReport } from './reporting/report.ts';
import { loadPlan, runPlan } from './planning/plan-stage.ts';

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, CONFIG: 3 } as const;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
}

const USAGE = `Usage: qa-agent <command> [--project <dir>] [options]

Commands:
  discover [--offline]     read config/docs/source, explore the app with Playwright MCP,
                           write .qa-agent/discovery/{project-map,observations}.json
  plan                     requirements docs + project map -> .qa-agent/plan/test-plan.{json,md}, test-cases.csv
  generate [--validate]    READY cases -> <testOutputRoot>/*.spec.ts (+ fixtures, Playwright config, case map);
                           --validate type-checks the output and lists it with Playwright
  run                      run the generated suite (isolated cases in parallel, shared-state cases serially);
                           credentials from QA_AGENT_ACCOUNT_<KEY>_USERNAME/_PASSWORD; records qa-artifacts/runs/<id>/
  report [--run <id>]      normalised results, failure analysis, requirement coverage ->
                           qa-artifacts/runs/<id>/report/{results.json,summary.md,report.html}
  full-test [--offline] [--resume]
                           discover -> plan -> generate -> run -> report; --resume skips unchanged finished stages`;

export interface Context {
  projectRoot: string;
  pluginRoot: string;
  config: ProjectConfig;
}

export function loadContext(projectArg: string | undefined, io: Io): Context {
  const projectRoot = projectArg
    ? path.resolve(io.cwd, projectArg)
    : resolveProjectRoot({ env: io.env, cwd: io.cwd });
  const pluginRoot = resolvePluginRoot({
    env: io.env,
    fallbackStart: path.dirname(fileURLToPath(import.meta.url)),
  });
  const loaded = loadProjectConfig(projectRoot);
  if (!loaded)
    throw new ConfigError(
      'No QA Agent config found (create .qa-agent/config.json)',
      path.join(projectRoot, '.qa-agent', 'config.json'),
    );
  return { projectRoot, pluginRoot, config: loaded.config };
}

export async function main(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        offline: { type: 'boolean' },
        validate: { type: 'boolean' },
        resume: { type: 'boolean' },
        run: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  const [command] = parsed.positionals;
  if (parsed.values.help || !command) {
    io.out(USAGE);
    return parsed.values.help ? EXIT.OK : EXIT.USAGE;
  }
  try {
    switch (command) {
      case 'discover': {
        const ctx = loadContext(parsed.values.project, io);
        if (!parsed.values.offline) assertEnvironmentAllowed(ctx.config, io.env, 'explore');
        const tools = parsed.values.offline ? null : await startPlaywrightTools(ctx);
        const res = await runDiscover({
          projectRoot: ctx.projectRoot,
          config: ctx.config,
          env: io.env,
          tools,
        });
        const m = res.map;
        io.out(
          [
            `discover: ${m.projectId}`,
            `  sources read: ${m.sources.read.length}, skipped: ${m.sources.skipped.length}`,
            `  routes: ${m.routes.length} (observed live: ${m.routes.filter((r) => r.observedIn.length).length}), forms: ${m.forms.length}, ui: ${m.ui.length}, roles: ${m.roles.length}`,
            `  live exploration: ${m.exploration.live ? `${m.exploration.pages} page(s), auth=${m.exploration.auth?.status ?? 'n/a'}, blocked=${m.exploration.blocked.length}` : 'off (--offline)'}`,
            `  wrote ${path.relative(ctx.projectRoot, res.files.projectMap)}`,
            `  wrote ${path.relative(ctx.projectRoot, res.files.observations)}`,
          ].join('\n'),
        );
        return m.exploration.auth?.status === 'failed' ? EXIT.FAILED : EXIT.OK;
      }
      case 'plan': {
        const ctx = loadContext(parsed.values.project, io);
        const { plan, files } = runPlan({ projectRoot: ctx.projectRoot, config: ctx.config });
        const count = (s: string) => plan.cases.filter((c) => c.status === s).length;
        io.out(
          [
            `plan: ${plan.projectId}`,
            `  requirements: ${plan.coverage.requirements} (with READY cases: ${plan.coverage.withReadyCases}) from ${plan.inputs.requirementsFiles.join(', ') || 'no requirement documents'}`,
            `  project map: ${plan.inputs.projectMap ?? 'none (run discover first for form/link resolution)'}`,
            `  cases: ${plan.cases.length} — READY ${count('READY')}, NEEDS_REVIEW ${count('NEEDS_REVIEW')}, BLOCKED ${count('BLOCKED')}`,
            ...files.map((f) => `  wrote ${path.relative(ctx.projectRoot, f)}`),
          ].join('\n'),
        );
        return EXIT.OK;
      }
      case 'run': {
        const ctx = loadContext(parsed.values.project, io);
        const record = await runSuite({
          projectRoot: ctx.projectRoot,
          config: ctx.config,
          plan: loadPlan(ctx.projectRoot),
          env: { ...io.env },
          out: (s) => io.out(s.replace(/\n$/, '')),
        });
        io.out(
          [
            `run ${record.runId}: exit=${record.exitCode}`,
            ...record.phases.map(
              (p) =>
                `  ${p.name}: ${p.cases} case(s), ${p.workers} worker(s), exit=${p.exitCode}, ${p.resultsFile}`,
            ),
            `  record: qa-artifacts/runs/${record.runId}/run.json`,
          ].join('\n'),
        );
        return record.exitCode === 0 ? EXIT.OK : EXIT.FAILED;
      }
      case 'report': {
        const ctx = loadContext(parsed.values.project, io);
        const { report, files } = runReport({
          projectRoot: ctx.projectRoot,
          config: ctx.config,
          env: io.env,
          ...(parsed.values.run ? { runId: parsed.values.run } : {}),
        });
        const c = report.coverage.counts;
        io.out(
          [
            `report ${report.runId}: passed ${c.passed}/${c.executed} executed (ready ${c.ready}, generated ${c.generated}), failed ${c.failed}, blocked ${c.blocked}, skipped ${c.skipped}, not run ${c.notRun}, flaky ${c.flaky}`,
            `  requirements: ${report.coverage.withReadyCases}/${report.coverage.requirements} with runnable cases, ${report.coverage.fullyPassing} fully passing`,
            ...report.analyses.map(
              (a) =>
                `  ${a.caseId}: ${a.classification} (${a.confidence}, ${a.source}) — ${a.rationale}`,
            ),
            ...files.map((f) => `  wrote ${path.relative(ctx.projectRoot, f)}`),
          ].join('\n'),
        );
        return c.failed + c.blocked === 0 ? EXIT.OK : EXIT.FAILED;
      }
      case 'full-test': {
        const ctx = loadContext(parsed.values.project, io);
        const res = await runFullTest({
          projectRoot: ctx.projectRoot,
          pluginRoot: ctx.pluginRoot,
          config: ctx.config,
          env: { ...io.env },
          out: io.out,
          offline: parsed.values.offline === true,
          resume: parsed.values.resume === true,
        });
        io.out(
          [
            `full-test: ${res.failedStage ? `stopped at ${res.failedStage}: ${res.error}` : 'all stages completed'}`,
            `  ran: ${res.ran.join(', ') || '—'}; resumed: ${res.resumed.join(', ') || '—'}`,
            ...res.reportFiles.map((f) => `  report: ${path.relative(ctx.projectRoot, f)}`),
            `  state: .qa-agent/full-test-state.json`,
          ].join('\n'),
        );
        if (res.failedStage) return EXIT.FAILED;
        const last = res.state.stages.report?.summary ?? '';
        return /failed 0, blocked 0/.test(last) ? EXIT.OK : EXIT.FAILED;
      }
      case 'generate': {
        const ctx = loadContext(parsed.values.project, io);
        const res = await runGenerate({
          projectRoot: ctx.projectRoot,
          config: ctx.config,
          plan: loadPlan(ctx.projectRoot),
          runtimeFile: path.join(ctx.pluginRoot, 'src/generator/runtime/qa-agent.fixtures.ts'),
        });
        const lines = [
          `generate: ${res.cases.length} READY case(s) -> ${res.outputRoot} (skipped ${res.skipped.length} not READY)`,
          `  written: ${res.written.length}, unchanged: ${res.unchanged.length}, removed: ${res.removed.length}`,
          ...res.conflicts.map(
            (c) => `  CONFLICT ${c.file}: ${c.reason}; new version in ${c.proposed}`,
          ),
          ...res.keptStale.map((f) => `  kept stale (edited) file ${f}`),
          ...(res.formatted ? [] : ['  note: prettier not found; output is unformatted']),
        ];
        let ok = res.conflicts.length === 0;
        if (parsed.values.validate) {
          const v = validateGenerated({
            projectRoot: ctx.projectRoot,
            outputRoot: res.outputRoot,
            pluginRoot: ctx.pluginRoot,
            expected: res.cases.length * ctx.config.browsers.length,
          });
          lines.push(
            `  typecheck: ${!v.typecheck.ran ? 'NOT RUN' : v.typecheck.ok ? 'ok' : 'FAILED'}`,
            `  playwright --list: ${v.listed} test(s) (expected ${res.cases.length * ctx.config.browsers.length})`,
          );
          if (!v.typecheck.ok) lines.push(v.typecheck.output);
          ok &&= v.ok;
        }
        io.out(lines.join('\n'));
        return ok ? EXIT.OK : EXIT.FAILED;
      }
      default:
        io.err(`Unknown command "${command}"\n\n${USAGE}`);
        return EXIT.USAGE;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      io.err(`config error (${e.configPath}): ${e.message}`);
      return EXIT.CONFIG;
    }
    if (e instanceof PolicyError) {
      io.err(`policy: ${e.message}`);
      return EXIT.FAILED;
    }
    if (e instanceof WriteDeniedError) {
      io.err(`write denied: ${e.message}`);
      return EXIT.CONFIG;
    }
    io.err(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return EXIT.FAILED;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    env: process.env,
    cwd: process.cwd(),
  });
}

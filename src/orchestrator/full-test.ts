// `full-test`: discover → plan → generate (+validate) → run → report with a resumable state file
// (.qa-agent/full-test-state.json). A stage is skipped on --resume only if it finished before
// and the hash of its inputs is unchanged; a failed stage stops the pipeline and is retried next time.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertEnvironmentAllowed } from '../config/policy.ts';
import type { ProjectConfig } from '../config/project-config.schema.ts';
import { writeProjectFile } from '../config/write-guard.ts';
import { runDiscover } from '../discovery/discover.ts';
import { startPlaywrightTools } from '../discovery/explorer.ts';
import { readProjectSources } from '../discovery/source-reader.ts';
import { runGenerate } from '../generator/generate.ts';
import { validateGenerated } from '../generator/validate.ts';
import { loadPlan, runPlan } from '../planning/plan-stage.ts';
import { runReport } from '../reporting/report.ts';
import { runSuite } from './run.ts';

export const STAGES = ['discover', 'plan', 'generate', 'run', 'report'] as const;
export type Stage = (typeof STAGES)[number];
export const STATE_FILE = '.qa-agent/full-test-state.json';

export interface StageState {
  status: 'done' | 'failed' | 'skipped';
  finishedAt: string;
  inputsHash: string;
  summary: string;
}

export interface FullTestState {
  schemaVersion: 1;
  updatedAt: string;
  runId: string | null;
  stages: Partial<Record<Stage, StageState>>;
}

export interface FullTestResult {
  state: FullTestState;
  ran: Stage[];
  resumed: Stage[];
  failedStage: Stage | null;
  error: string | null;
  reportFiles: string[];
}

const sha = (parts: string[]) =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
const readIf = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

function inputsHash(
  stage: Stage,
  projectRoot: string,
  config: ProjectConfig,
  runtimeFile: string,
  offline: boolean,
): string {
  const p = (rel: string) => readIf(path.join(projectRoot, rel));
  const cfg = JSON.stringify(config);
  switch (stage) {
    case 'discover': {
      const { files } = readProjectSources(projectRoot, {
        docsPaths: config.docsPaths,
        sourcePaths: config.sourcePaths,
      });
      return sha([cfg, String(offline), ...files.map((f) => `${f.path}:${f.content}`)]);
    }
    case 'plan': {
      const { files } = readProjectSources(projectRoot, {
        docsPaths: config.docsPaths,
        sourcePaths: [],
      });
      return sha([
        cfg,
        p('.qa-agent/discovery/project-map.json'),
        ...files.map((f) => `${f.path}:${f.content}`),
      ]);
    }
    case 'generate':
      return sha([cfg, p('.qa-agent/plan/test-plan.json'), readIf(runtimeFile)]);
    case 'run':
      // A run is only reused when nothing it depends on changed (specs, plan, config).
      return sha([
        cfg,
        p(`${config.testOutputRoot}/.qa-agent-manifest.json`),
        p('.qa-agent/plan/test-plan.json'),
      ]);
    case 'report':
      return sha([String(Date.now())]); // always regenerated (cheap)
  }
}

export async function runFullTest(options: {
  projectRoot: string;
  pluginRoot: string;
  config: ProjectConfig;
  env: NodeJS.ProcessEnv;
  out: (s: string) => void;
  offline?: boolean;
  resume?: boolean;
}): Promise<FullTestResult> {
  const { projectRoot, config, out } = options;
  const runtimeFile = path.join(options.pluginRoot, 'src/generator/runtime/qa-agent.fixtures.ts');
  const stateAbs = path.join(projectRoot, STATE_FILE);
  const previous: FullTestState | null =
    options.resume && fs.existsSync(stateAbs)
      ? (JSON.parse(fs.readFileSync(stateAbs, 'utf8')) as FullTestState)
      : null;
  const state: FullTestState = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    runId: previous?.runId ?? null,
    stages: { ...(previous?.stages ?? {}) },
  };
  const save = () => {
    state.updatedAt = new Date().toISOString();
    writeProjectFile(projectRoot, config, STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  };
  const result: FullTestResult = {
    state,
    ran: [],
    resumed: [],
    failedStage: null,
    error: null,
    reportFiles: [],
  };

  for (const stage of STAGES) {
    const hash = inputsHash(stage, projectRoot, config, runtimeFile, options.offline === true);
    const before = previous?.stages[stage];
    if (before?.status === 'done' && before.inputsHash === hash && stage !== 'report') {
      out(`== ${stage}: resumed (unchanged since ${before.finishedAt}) — ${before.summary}`);
      result.resumed.push(stage);
      continue;
    }
    out(`== ${stage}`);
    try {
      let summary = '';
      switch (stage) {
        case 'discover': {
          if (!options.offline) assertEnvironmentAllowed(config, options.env, 'explore');
          const tools = options.offline
            ? null
            : await startPlaywrightTools({ pluginRoot: options.pluginRoot, projectRoot, config });
          const d = await runDiscover({ projectRoot, config, env: options.env, tools });
          if (d.map.exploration.auth?.status === 'failed')
            throw new Error(`sign-in for exploration failed: ${d.map.exploration.auth.detail}`);
          summary = `${d.map.routes.length} routes, ${d.map.exploration.pages} observed page(s), auth ${d.map.exploration.auth?.status ?? 'n/a'}`;
          break;
        }
        case 'plan': {
          const { plan } = runPlan({ projectRoot, config });
          const ready = plan.cases.filter((c) => c.status === 'READY').length;
          if (ready === 0) throw new Error('the plan has no READY case');
          summary = `${plan.cases.length} cases, ${ready} READY`;
          break;
        }
        case 'generate': {
          const g = await runGenerate({
            projectRoot,
            config,
            plan: loadPlan(projectRoot),
            runtimeFile,
          });
          if (g.conflicts.length)
            throw new Error(
              `generated files were edited: ${g.conflicts.map((c) => c.file).join(', ')}`,
            );
          const v = validateGenerated({
            projectRoot,
            outputRoot: config.testOutputRoot,
            pluginRoot: options.pluginRoot,
            expected: g.cases.length * config.browsers.length, // one per browser project
          });
          if (!v.ok) throw new Error(`validation failed: ${v.problems.join('; ')}`);
          summary = `${g.cases.length} tests, type-check ${v.typecheck.ran ? 'ok' : 'not run (no TypeScript)'}, ${v.listed} listed`;
          break;
        }
        case 'run': {
          const record = await runSuite({
            projectRoot,
            config,
            plan: loadPlan(projectRoot),
            env: options.env,
            out: (s) => out(s.replace(/\n$/, '')),
          });
          state.runId = record.runId;
          // Test failures are results, not a pipeline failure: the report explains them.
          summary = `${record.runId}: ${record.phases.map((p) => `${p.name} exit=${p.exitCode}`).join(', ')}`;
          break;
        }
        case 'report': {
          if (!state.runId) throw new Error('no run to report on');
          const { report, files } = runReport({
            projectRoot,
            config,
            runId: state.runId,
            env: options.env,
          });
          result.reportFiles = files;
          const c = report.coverage.counts;
          summary = `passed ${c.passed}/${c.executed}, failed ${c.failed}, blocked ${c.blocked}, not run ${c.notRun}`;
          break;
        }
      }
      state.stages[stage] = {
        status: 'done',
        finishedAt: new Date().toISOString(),
        inputsHash: hash,
        summary,
      };
      result.ran.push(stage);
      out(`   ${summary}`);
      save();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.stages[stage] = {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        inputsHash: hash,
        summary: message,
      };
      // Later stages are stale once an earlier one failed.
      const keep = STAGES.slice(0, STAGES.indexOf(stage) + 1);
      state.stages = Object.fromEntries(
        Object.entries(state.stages).filter(([s]) => keep.includes(s as Stage)),
      );
      result.failedStage = stage;
      result.error = message;
      out(`   FAILED: ${message}`);
      save();
      break;
    }
  }
  return result;
}

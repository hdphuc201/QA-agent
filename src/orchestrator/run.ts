// `run` stage: executes the generated suite with the target project's Playwright in two phases —
// isolated cases in parallel (worker budget), then shared-state cases serially — and records the run
// under qa-artifacts/runs/<runId>/. AI is not involved; PASS/FAIL is Playwright's verdict.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUp, PLUGIN_MANIFEST } from '../config/paths.ts';
import type { ProjectConfig } from '../config/project-config.schema.ts';
import { assertWritable, writeProjectFile } from '../config/write-guard.ts';
import { PW_CONFIG } from '../generator/generate.ts';
import { resolveFromProject } from '../generator/validate.ts';
import type { TestPlan } from '../planning/schema.ts';
import { assertEnvironmentAllowed } from '../config/policy.ts';
import { scrubArtifacts } from '../evidence/scrub.ts';
import { secretValues } from '../reporting/normalize.ts';
import { buildSchedule, type Schedule } from './scheduler.ts';

export interface RunPhase {
  name: 'parallel' | 'serial';
  workers: number;
  grep: string;
  cases: number;
  exitCode: number | null;
  resultsFile: string;
  durationMs: number;
  /** Credential values removed from this phase's artifacts (traces, reports). */
  scrub?: { replacements: number; files: number; errors: number };
}

export interface RunMetadata {
  qaAgentVersion: string;
  node: string;
  platform: string;
  playwrightVersion: string | null;
  browser: string;
  buildId: string;
  environment: string;
}

export interface RunRecord {
  schemaVersion: 1;
  metadata: RunMetadata;
  runId: string;
  projectId: string;
  startedAt: string;
  finishedAt: string;
  baseURL: string;
  schedule: Schedule;
  phases: RunPhase[];
  exitCode: number;
}

export const RUNS_DIR = 'qa-artifacts/runs';

/** Runtime facts for the report. Deliberately no environment dump: it could hold credentials. */
export function collectMetadata(
  projectRoot: string,
  config: ProjectConfig,
  env: NodeJS.ProcessEnv,
): RunMetadata {
  const pwPkg = resolveFromProject(projectRoot, '@playwright/test/package.json');
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  const gitHead = git.status === 0 ? git.stdout.trim() : '';
  return {
    qaAgentVersion: QA_AGENT_VERSION,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    playwrightVersion: pwPkg
      ? (JSON.parse(fs.readFileSync(pwPkg, 'utf8')) as { version: string }).version
      : null,
    browser: config.browsers
      .map((b) =>
        b === 'chromium' && env.QA_AGENT_BROWSER_CHANNEL
          ? `chromium (channel ${env.QA_AGENT_BROWSER_CHANNEL})`
          : b,
      )
      .join(', '),
    buildId: env.QA_AGENT_BUILD_ID ?? (gitHead ? `git:${gitHead}` : 'unknown'),
    environment: config.environment,
  };
}

// The plugin manifest above this module (works from src/ and from the bundled bin/).
const pluginDir = findUp(path.dirname(fileURLToPath(import.meta.url)), (d) =>
  fs.existsSync(path.join(d, PLUGIN_MANIFEST)),
);
const QA_AGENT_VERSION = pluginDir
  ? (
      JSON.parse(fs.readFileSync(path.join(pluginDir, PLUGIN_MANIFEST), 'utf8')) as {
        version: string;
      }
    ).version
  : 'unknown';

/**
 * Freeze the stage outputs a run used (`inputs/`) plus their versions, so a run can be
 * reproduced and audited after the plan or specs change.
 */
export function snapshotInputs(
  projectRoot: string,
  config: ProjectConfig,
  runDir: string,
  plan: TestPlan,
): void {
  const sources: [string, string][] = [
    ['.qa-agent/discovery/project-map.json', 'project-map.json'],
    ['.qa-agent/discovery/observations.json', 'observations.json'],
    ['.qa-agent/plan/test-plan.json', 'test-plan.json'],
    [`${config.testOutputRoot}/case-map.json`, 'case-map.json'],
    [`${config.testOutputRoot}/.qa-agent-manifest.json`, 'generated-manifest.json'],
  ];
  const copied: string[] = [];
  for (const [from, to] of sources) {
    const abs = path.join(projectRoot, from);
    if (!fs.existsSync(abs)) continue;
    writeProjectFile(projectRoot, config, `${runDir}/inputs/${to}`, fs.readFileSync(abs, 'utf8'));
    copied.push(from);
  }
  const manifest = path.join(projectRoot, config.testOutputRoot, '.qa-agent-manifest.json');
  const versions = {
    qaAgent: QA_AGENT_VERSION,
    planSchemaVersion: plan.schemaVersion,
    planGeneratedAt: plan.generatedAt,
    generatedPlanHash: fs.existsSync(manifest)
      ? (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { planHash: string }).planHash
      : null,
    inputs: copied,
  };
  writeProjectFile(
    projectRoot,
    config,
    `${runDir}/inputs/versions.json`,
    `${JSON.stringify(versions, null, 2)}\n`,
  );
}

export function newRunId(now = new Date()): string {
  return `run-${now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')}-${Math.random().toString(36).slice(2, 6)}`;
}

function runPlaywright(
  cli: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; out: (s: string) => void },
) {
  return new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => options.out(d));
    child.stderr.on('data', (d: string) => options.out(d));
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });
}

export async function runSuite(options: {
  projectRoot: string;
  config: ProjectConfig;
  plan: TestPlan;
  env: NodeJS.ProcessEnv;
  out: (s: string) => void;
  runId?: string;
  extraArgs?: string[];
}): Promise<RunRecord> {
  const { projectRoot, config, plan } = options;
  const cli = resolveFromProject(projectRoot, '@playwright/test/cli');
  if (!cli) throw new Error('BLOCKED: the target project has no @playwright/test installed');
  const pwConfig = path.join(projectRoot, config.testOutputRoot, PW_CONFIG);
  if (!fs.existsSync(pwConfig))
    throw new Error(`${path.relative(projectRoot, pwConfig)} not found — run "generate" first`);

  // Only the plan's generated specs (from the case map): custom specs in the folder are not part of a run.
  const caseMapFile = path.join(projectRoot, config.testOutputRoot, 'case-map.json');
  if (!fs.existsSync(caseMapFile))
    throw new Error('case-map.json not found — run "generate" first');
  const caseMap = JSON.parse(fs.readFileSync(caseMapFile, 'utf8')) as {
    cases: { id: string; file: string }[];
  };
  const specFiles = [...new Set(caseMap.cases.map((c) => path.basename(c.file)))].sort();

  assertEnvironmentAllowed(config, options.env, 'run tests');
  const secrets = secretValues(options.env);
  // A run that was killed earlier never reached its scrub step: scrub it now.
  const runsAbs = path.join(projectRoot, RUNS_DIR);
  if (fs.existsSync(runsAbs)) {
    for (const d of fs.readdirSync(runsAbs)) {
      if (!fs.existsSync(path.join(runsAbs, d, 'run.json')))
        scrubArtifacts(path.join(runsAbs, d), secrets);
    }
  }

  const runId = options.runId ?? newRunId();
  const runDir = `${RUNS_DIR}/${runId}`;
  const schedule = buildSchedule(plan, config);
  writeProjectFile(
    projectRoot,
    config,
    `${runDir}/schedule.json`,
    `${JSON.stringify(schedule, null, 2)}\n`,
  );
  snapshotInputs(projectRoot, config, runDir, plan);
  const startedAt = new Date().toISOString();
  const phases: RunPhase[] = [];
  const plannedPhases: [RunPhase['name'], string[], number, string][] = [
    ['parallel', schedule.parallel, schedule.workers.parallel, '--grep-invert=@serial'],
    ['serial', schedule.serial, 1, '--grep=@serial'],
  ];
  for (const [name, ids, workers, grep] of plannedPhases) {
    if (!ids.length) continue;
    const resultsFile = `${runDir}/results-${name}.json`;
    const abs = path.join(projectRoot, resultsFile);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    options.out(`\n== ${name}: ${ids.length} case(s), ${workers} worker(s)\n`);
    const t0 = Date.now();
    const code = await runPlaywright(
      cli,
      [
        'test',
        '-c',
        pwConfig,
        grep,
        `--workers=${workers}`,
        '--reporter=list,json,html',
        // Per-phase output dir: Playwright empties it at start, so phases must not share one.
        `--output=${path.join(projectRoot, runDir, `test-results-${name}`)}`,
        ...(options.extraArgs ?? []),
        ...specFiles,
      ],
      {
        cwd: projectRoot,
        env: {
          ...options.env,
          FORCE_COLOR: '0',
          QA_AGENT_RUN_ID: runId,
          PLAYWRIGHT_JSON_OUTPUT_FILE: abs,
          PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(projectRoot, runDir, `html-${name}`),
          PLAYWRIGHT_HTML_OPEN: 'never',
        },
        out: options.out,
      },
    );
    // Traces record typed values and request bodies: remove credential values right away.
    const scrub = scrubArtifacts(path.join(projectRoot, runDir), secrets);
    if (scrub.replacements)
      options.out(
        `   scrubbed ${scrub.replacements} credential value(s) in ${scrub.filesChanged.length} artifact(s)\n`,
      );
    for (const e of scrub.errors) options.out(`   WARNING scrub failed: ${e}\n`);
    phases.push({
      name,
      workers,
      grep,
      cases: ids.length,
      exitCode: code,
      resultsFile,
      durationMs: Date.now() - t0,
      scrub: {
        replacements: scrub.replacements,
        files: scrub.filesChanged.length,
        errors: scrub.errors.length,
      },
    });
  }
  // Sessions hold cookies: the engine deletes them after every run, even a failed or interrupted one.
  if (config.session.cache && config.session.purgeAfterRun) {
    fs.rmSync(assertWritable(projectRoot, config, 'qa-artifacts/auth'), {
      recursive: true,
      force: true,
    });
  }
  const record: RunRecord = {
    schemaVersion: 1,
    metadata: collectMetadata(projectRoot, config, options.env),
    runId,
    projectId: config.projectId,
    startedAt,
    finishedAt: new Date().toISOString(),
    baseURL: options.env.QA_AGENT_BASE_URL ?? config.baseURL,
    schedule,
    phases,
    exitCode: phases.every((p) => p.exitCode === 0) ? 0 : 1,
  };
  writeProjectFile(
    projectRoot,
    config,
    `${runDir}/run.json`,
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

// `plan` stage: requirements docs + discovery map → `.qa-agent/plan/test-plan.{json,md}` + CSV.

import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config/project-config.schema.ts';
import { writeProjectFile } from '../config/write-guard.ts';
import { DISCOVERY_DIR, ProjectMapFileSchema, type ProjectMapFile } from '../discovery/discover.ts';
import { readProjectSources } from '../discovery/source-reader.ts';
import { planToCsv, planToMarkdown } from './export.ts';
import { buildPlan } from './planner.ts';
import { linkRequirements, parseRequirementsDoc } from './requirements.ts';
import { TestPlanSchema, type TestPlan } from './schema.ts';

export const PLAN_DIR = '.qa-agent/plan';
export const PLAN_FILE = `${PLAN_DIR}/test-plan.json`;

export function loadProjectMap(projectRoot: string): {
  map: ProjectMapFile | null;
  file: string | null;
} {
  const file = path.join(projectRoot, DISCOVERY_DIR, 'project-map.json');
  if (!fs.existsSync(file)) return { map: null, file: null };
  return {
    map: ProjectMapFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))),
    file: `${DISCOVERY_DIR}/project-map.json`,
  };
}

export function loadPlan(projectRoot: string): TestPlan {
  const file = path.join(projectRoot, PLAN_FILE);
  if (!fs.existsSync(file)) throw new Error(`${PLAN_FILE} not found — run "plan" first`);
  return TestPlanSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function runPlan(options: {
  projectRoot: string;
  config: ProjectConfig;
  now?: () => Date;
}): {
  plan: TestPlan;
  files: string[];
} {
  const { projectRoot, config } = options;
  const { files } = readProjectSources(projectRoot, {
    docsPaths: config.docsPaths,
    sourcePaths: [],
  });
  const docs = files.filter((f) => /\.(md|markdown|txt)$/i.test(f.path));
  const requirementsFiles: string[] = [];
  const parsed = docs.flatMap((f) => {
    const reqs = parseRequirementsDoc(f);
    if (reqs.length) requirementsFiles.push(f.path);
    return reqs;
  });
  const ids = parsed.map((r) => r.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`requirement id ${dup} is defined more than once`);
  const { map, file } = loadProjectMap(projectRoot);
  const plan = buildPlan({
    config,
    requirements: linkRequirements(parsed, map),
    map,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    requirementsFiles,
    projectMapPath: file,
  });
  const out = [
    writeProjectFile(projectRoot, config, PLAN_FILE, `${JSON.stringify(plan, null, 2)}\n`),
    writeProjectFile(projectRoot, config, `${PLAN_DIR}/test-plan.md`, planToMarkdown(plan)),
    writeProjectFile(projectRoot, config, `${PLAN_DIR}/test-cases.csv`, planToCsv(plan)),
  ];
  return { plan, files: out };
}

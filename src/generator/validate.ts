// Validation of generated output: TypeScript compile (strict) and Playwright test discovery.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PW_CONFIG } from './generate.ts';

export interface ValidationResult {
  ok: boolean;
  typecheck: { ok: boolean; output: string };
  listed: number;
  listOutput: string;
  problems: string[];
}

function readCaseIds(outAbs: string): string[] {
  const file = path.join(outAbs, 'case-map.json');
  if (!fs.existsSync(file)) return [];
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: { id: string }[] }).cases.map(
    (c) => c.id,
  );
}

/** Resolve a package file from the target project (its own node_modules). */
export function resolveFromProject(projectRoot: string, request: string): string | null {
  try {
    return createRequire(path.join(projectRoot, 'package.json')).resolve(request);
  } catch {
    return null;
  }
}

export function validateGenerated(options: {
  projectRoot: string;
  outputRoot: string;
  pluginRoot: string;
  expected: number;
}): ValidationResult {
  const { projectRoot, outputRoot, pluginRoot } = options;
  const problems: string[] = [];
  const outAbs = path.join(projectRoot, outputRoot);

  // 1. Strict TypeScript compile of the generated files only.
  const tsc = path.join(pluginRoot, 'node_modules/typescript/bin/tsc');
  const workDir = path.join(projectRoot, 'qa-artifacts/qa-agent');
  fs.mkdirSync(workDir, { recursive: true });
  const tsconfig = path.join(workDir, 'tsconfig.generated.json');
  fs.writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          skipLibCheck: true,
          // Playwright's own typings import node modules, so Playwright projects carry @types/node.
          types: ['node'],
        },
        include: [path.relative(workDir, path.join(outAbs, '**/*.ts')).split(path.sep).join('/')],
      },
      null,
      2,
    ),
  );
  const tc = spawnSync(process.execPath, [tsc, '-p', tsconfig], {
    encoding: 'utf8',
    cwd: projectRoot,
  });
  const typecheck = { ok: tc.status === 0, output: `${tc.stdout}${tc.stderr}`.trim() };
  if (!typecheck.ok) problems.push('generated code does not type-check');

  // 2. Playwright discovery with the target project's own @playwright/test.
  const cli = resolveFromProject(projectRoot, '@playwright/test/cli');
  let listed = 0;
  let listOutput = '';
  if (!cli) {
    problems.push('BLOCKED: the target project has no @playwright/test installed');
  } else {
    const r = spawnSync(
      process.execPath,
      [cli, 'test', '--list', '--reporter=list', '-c', path.join(outAbs, PW_CONFIG)],
      {
        encoding: 'utf8',
        cwd: projectRoot,
        env: { ...process.env, FORCE_COLOR: '0' },
      },
    );
    listOutput = `${r.stdout}${r.stderr}`.trim();
    // Count only generated tests (case IDs from the case map); custom specs may live alongside.
    const ids = readCaseIds(outAbs);
    listed = listOutput.split('\n').filter((l) => ids.some((id) => l.includes(`› ${id} `))).length;
    if (r.status !== 0) problems.push(`playwright --list failed (exit ${r.status})`);
    if (listed !== options.expected)
      problems.push(`playwright lists ${listed} test(s), expected ${options.expected}`);
  }
  return { ok: problems.length === 0, typecheck, listed, listOutput, problems };
}

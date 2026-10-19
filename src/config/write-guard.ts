// QA Agent writes only inside the project's write allowlist and never into readOnlyPaths.

import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './paths.ts';
import { writeAllowlist, type ProjectConfig } from './project-config.schema.ts';

export class WriteDeniedError extends Error {
  override name = 'WriteDeniedError';
}

export function assertWritable(projectRoot: string, cfg: ProjectConfig, target: string): string {
  const abs = path.resolve(projectRoot, target);
  const allowed = writeAllowlist(cfg).map((d) => path.resolve(projectRoot, d));
  if (!allowed.some((d) => isInside(d, abs))) {
    throw new WriteDeniedError(
      `write outside the allowlist (${writeAllowlist(cfg).join(', ')}): ${target}`,
    );
  }
  const ro = cfg.readOnlyPaths
    .map((d) => path.resolve(projectRoot, d))
    .find((d) => isInside(d, abs));
  if (ro) throw new WriteDeniedError(`write into a read-only path: ${target}`);
  // Refuse to write through a symlinked parent that leaves the project.
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  if (!isInside(fs.realpathSync(projectRoot), fs.realpathSync(dir))) {
    throw new WriteDeniedError(`write target resolves outside the project: ${target}`);
  }
  return abs;
}

/** Guarded write (creates parent directories inside the allowlist). */
export function writeProjectFile(
  projectRoot: string,
  cfg: ProjectConfig,
  target: string,
  content: string,
): string {
  const abs = assertWritable(projectRoot, cfg, target);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

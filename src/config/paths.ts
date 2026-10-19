// Path adapter: locates the plugin root, the target project root and its QA Agent config.
// Pure path logic takes a `PathImpl` so Windows semantics can be tested on any OS.

import fs from 'node:fs';
import path from 'node:path';

export type PathImpl = typeof path.posix;
export type Env = Readonly<Record<string, string | undefined>>;

export const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';
export const CONFIG_DIR = '.qa-agent';
export const CONFIG_FILE = '.qa-agent/config.json';

export class PathResolutionError extends Error {
  override name = 'PathResolutionError';
}

export class ConfigError extends Error {
  override name = 'ConfigError';
  readonly configPath: string;
  constructor(message: string, configPath: string) {
    super(message);
    this.configPath = configPath;
  }
}

/** True when `child` equals or lies inside `parent` (`path.win32.relative` is case-insensitive). */
export function isInside(parent: string, child: string, impl: PathImpl = path): boolean {
  const rel = impl.relative(impl.resolve(parent), impl.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !impl.isAbsolute(rel));
}

/** Forward-slash form, e.g. for MCP args or display (Windows accepts it). */
export function toPortablePath(p: string): string {
  return p.replace(/\\/g, '/');
}

const isDir = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
const isFile = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() === true;

/** Walk from `start` up to the filesystem root, returning the first directory where `match` holds. */
export function findUp(start: string, match: (dir: string) => boolean): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (match(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Plugin root: `CLAUDE_PLUGIN_ROOT` when set (Claude Code exports it to plugin processes),
 * otherwise the nearest ancestor of `fallbackStart` that holds `.claude-plugin/plugin.json`.
 */
/** Version from the plugin manifest above `start` (works from src/ and from the bundled bin/). */
export function pluginVersion(start: string): string {
  const dir = findUp(start, (d) => isFile(path.join(d, PLUGIN_MANIFEST)));
  if (!dir) return 'unknown';
  const m = JSON.parse(fs.readFileSync(path.join(dir, PLUGIN_MANIFEST), 'utf8')) as {
    version?: string;
  };
  return m.version ?? 'unknown';
}

export function resolvePluginRoot(options: { env?: Env; fallbackStart: string }): string {
  const fromEnv = options.env?.CLAUDE_PLUGIN_ROOT;
  if (fromEnv) {
    const root = path.resolve(fromEnv);
    if (!isFile(path.join(root, PLUGIN_MANIFEST))) {
      throw new PathResolutionError(`CLAUDE_PLUGIN_ROOT has no ${PLUGIN_MANIFEST}: ${root}`);
    }
    return root;
  }
  const found = findUp(options.fallbackStart, (d) => isFile(path.join(d, PLUGIN_MANIFEST)));
  if (!found)
    throw new PathResolutionError(`No ${PLUGIN_MANIFEST} found above ${options.fallbackStart}`);
  return found;
}

/**
 * Project root of the app under test: `CLAUDE_PROJECT_DIR` when set, otherwise the nearest
 * ancestor of `cwd` with a `.qa-agent/` directory, then the nearest Git root, then `cwd`.
 */
export function resolveProjectRoot(options: { env?: Env; cwd: string }): string {
  const fromEnv = options.env?.CLAUDE_PROJECT_DIR;
  if (fromEnv) {
    const root = path.resolve(fromEnv);
    if (!isDir(root))
      throw new PathResolutionError(`CLAUDE_PROJECT_DIR is not a directory: ${root}`);
    return root;
  }
  return (
    findUp(options.cwd, (d) => isDir(path.join(d, CONFIG_DIR))) ??
    findUp(options.cwd, (d) => fs.existsSync(path.join(d, '.git'))) ??
    path.resolve(options.cwd)
  );
}

/** `<projectRoot>/.qa-agent/config.json` when it exists, else null. */
export function findProjectConfig(projectRoot: string): string | null {
  const file = path.join(projectRoot, CONFIG_FILE);
  return isFile(file) ? file : null;
}

/**
 * Reads the project config as untyped JSON. Schema validation arrives in P2
 * (`project-config.schema.ts`); here we only guarantee a JSON object inside the project.
 */
export function readProjectConfig(
  projectRoot: string,
): { path: string; data: Record<string, unknown> } | null {
  const file = findProjectConfig(projectRoot);
  if (!file) return null;
  if (!isInside(projectRoot, fs.realpathSync(file))) {
    throw new ConfigError('Config resolves outside the project root (symlink?)', file);
  }
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(
      `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      file,
    );
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ConfigError('Config must be a JSON object', file);
  }
  return { path: file, data: data as Record<string, unknown> };
}

export interface ResolvedContext {
  pluginRoot: string;
  projectRoot: string;
  configPath: string | null;
}

/** One-shot resolution used by skills/CLIs. */
export function resolveContext(options: {
  env?: Env;
  cwd: string;
  fallbackStart: string;
}): ResolvedContext {
  const pluginRoot = resolvePluginRoot(options);
  const projectRoot = resolveProjectRoot(options);
  return { pluginRoot, projectRoot, configPath: findProjectConfig(projectRoot) };
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  PathResolutionError,
  findProjectConfig,
  isInside,
  readProjectConfig,
  resolveContext,
  resolvePluginRoot,
  resolveProjectRoot,
  toPortablePath,
} from '../../src/config/paths.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temps: string[] = [];
after(() => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
});

/** Temp tree whose every level contains spaces, like `C:\Users\A B\My Projects\...`. */
function tree(files: Record<string, string>): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qa paths '));
  temps.push(base);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(base, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return base;
}

describe('isInside', () => {
  test('Windows paths: spaces, drive-letter case, traversal', () => {
    const w = path.win32;
    assert.ok(
      isInside('C:\\My Projects\\app one', 'C:\\My Projects\\app one\\.qa-agent\\config.json', w),
    );
    assert.ok(isInside('C:\\My Projects\\app one', 'c:\\my projects\\APP ONE\\src', w));
    assert.ok(isInside('C:\\My Projects\\app one', 'C:\\My Projects\\app one', w));
    assert.ok(!isInside('C:\\My Projects\\app one', 'C:\\My Projects\\app one two', w));
    assert.ok(!isInside('C:\\My Projects\\app one', 'C:\\My Projects\\app one\\..\\secrets', w));
    assert.ok(!isInside('C:\\My Projects\\app one', 'D:\\My Projects\\app one', w));
  });

  test('POSIX paths are case-sensitive', () => {
    const p = path.posix;
    assert.ok(isInside('/home/a b/app', '/home/a b/app/x y', p));
    assert.ok(!isInside('/home/a b/app', '/home/a b/App/x', p));
    assert.ok(!isInside('/home/a b/app', '/home/a b/app/../other', p));
  });

  test('toPortablePath converts separators only', () => {
    assert.equal(toPortablePath('C:\\My Projects\\qa agent'), 'C:/My Projects/qa agent');
    assert.equal(toPortablePath('/already/posix path'), '/already/posix path');
  });
});

describe('resolvePluginRoot', () => {
  test('finds this repository from a nested directory', () => {
    assert.equal(
      resolvePluginRoot({ fallbackStart: path.join(repoRoot, 'src', 'config') }),
      repoRoot,
    );
  });

  test('prefers CLAUDE_PLUGIN_ROOT and handles spaces', () => {
    const base = tree({ 'my plugin/.claude-plugin/plugin.json': '{"name":"x"}' });
    const root = path.join(base, 'my plugin');
    assert.equal(
      resolvePluginRoot({ env: { CLAUDE_PLUGIN_ROOT: root }, fallbackStart: os.tmpdir() }),
      root,
    );
    // Claude Code substitutes forward-slash paths on Windows; they must resolve too.
    assert.equal(
      resolvePluginRoot({
        env: { CLAUDE_PLUGIN_ROOT: toPortablePath(root) },
        fallbackStart: os.tmpdir(),
      }),
      root,
    );
  });

  test('rejects a CLAUDE_PLUGIN_ROOT without manifest and a tree without plugin', () => {
    const base = tree({ 'empty dir/readme.txt': 'x' });
    assert.throws(
      () =>
        resolvePluginRoot({
          env: { CLAUDE_PLUGIN_ROOT: path.join(base, 'empty dir') },
          fallbackStart: base,
        }),
      PathResolutionError,
    );
    assert.throws(
      () => resolvePluginRoot({ fallbackStart: path.join(base, 'empty dir') }),
      PathResolutionError,
    );
  });
});

describe('resolveProjectRoot and config discovery', () => {
  test('nearest .qa-agent wins over the Git root', () => {
    const base = tree({
      'mono repo/.git/HEAD': 'ref: refs/heads/main',
      'mono repo/apps/web app/.qa-agent/config.json': '{"projectId":"web"}',
      'mono repo/apps/web app/src/pages/home.tsx': '',
    });
    const app = path.join(base, 'mono repo', 'apps', 'web app');
    const cwd = path.join(app, 'src', 'pages');
    assert.equal(resolveProjectRoot({ cwd }), app);
    assert.equal(findProjectConfig(app), path.join(app, '.qa-agent', 'config.json'));
    assert.deepEqual(readProjectConfig(app)?.data, { projectId: 'web' });
  });

  test('falls back to the Git root, then cwd', () => {
    const base = tree({
      'repo x/.git/HEAD': '',
      'repo x/sub dir/file.txt': '',
      'loose dir/a.txt': '',
    });
    assert.equal(
      resolveProjectRoot({ cwd: path.join(base, 'repo x', 'sub dir') }),
      path.join(base, 'repo x'),
    );
    const loose = path.join(base, 'loose dir');
    const root = resolveProjectRoot({ cwd: loose });
    assert.ok(root === loose || isInside(root, loose), 'cwd or an enclosing git root');
    assert.equal(findProjectConfig(path.join(base, 'repo x')), null);
    assert.equal(readProjectConfig(path.join(base, 'repo x')), null);
  });

  test('CLAUDE_PROJECT_DIR overrides discovery and must exist', () => {
    const base = tree({ 'target app/.qa-agent/config.json': '{}' });
    const target = path.join(base, 'target app');
    assert.equal(
      resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: target }, cwd: os.tmpdir() }),
      target,
    );
    assert.throws(
      () =>
        resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: path.join(base, 'missing') }, cwd: base }),
      PathResolutionError,
    );
  });

  test('invalid config JSON or non-object config raises ConfigError with the path', () => {
    const base = tree({
      'bad json/.qa-agent/config.json': '{oops',
      'array cfg/.qa-agent/config.json': '[]',
    });
    for (const dir of ['bad json', 'array cfg']) {
      const root = path.join(base, dir);
      assert.throws(
        () => readProjectConfig(root),
        (err: unknown) =>
          err instanceof ConfigError &&
          err.configPath === path.join(root, '.qa-agent', 'config.json'),
      );
    }
  });

  test('resolveContext combines plugin, project and config', () => {
    const base = tree({ 'shop app/.qa-agent/config.json': '{}' });
    const ctx = resolveContext({
      env: { CLAUDE_PLUGIN_ROOT: repoRoot },
      cwd: path.join(base, 'shop app'),
      fallbackStart: base,
    });
    assert.deepEqual(ctx, {
      pluginRoot: repoRoot,
      projectRoot: path.join(base, 'shop app'),
      configPath: path.join(base, 'shop app', '.qa-agent', 'config.json'),
    });
  });
});

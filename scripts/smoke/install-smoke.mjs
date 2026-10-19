#!/usr/bin/env node
// P9 install smoke: install the plugin the way a user does and run the INSTALLED engine.
//  1. `git clone` the given ref (tracked files only, like a GitHub install), or use --github owner/repo
//  2. `claude plugin marketplace add` + `claude plugin install` into an isolated CLAUDE_CONFIG_DIR
//  3. the installed copy must have no node_modules but the bundle, skills, agent and hook
//  4. a fresh target project (helpdesk example, only @playwright/test installed) runs
//     `node <installed>/bin/qa-agent.mjs full-test --offline` against the local example app
//
// Usage: node scripts/smoke/install-smoke.mjs [--ref HEAD] [--github hdphuc201/QA-agent] [--out evidence/P9]

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { makeTextRedactor } from './redact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({
  options: { ref: { type: 'string' }, github: { type: 'string' }, out: { type: 'string' } },
});
const outDir = path.resolve(root, values.out ?? 'evidence/P9');
const PASSWORDS = ['carol-helpdesk', 'dan-helpdesk', 'erin-helpdesk'];
const redact = makeTextRedactor({ secrets: PASSWORDS });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa install smoke '));
/** @type {string[]} */
const log = [];
/** @type {Record<string, unknown>} */
const checks = {
  startedAt: new Date().toISOString(),
  source: values.github ?? `git clone ${values.ref ?? 'HEAD'}`,
};
const say = (/** @type {string} */ s) => {
  log.push(redact(s));
  process.stdout.write(`${redact(s)}\n`);
};
/** @param {string} cmd @param {string[]} args @param {import('node:child_process').SpawnSyncOptions} [opts] */
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: false,
    timeout: 900_000,
    ...opts,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  say(
    `$ ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')} -> exit=${r.status}`,
  );
  return { code: r.status, out };
};
/** @type {NodeJS.ProcessEnv & { CLAUDE_CONFIG_DIR: string }} */
const claudeEnv = { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config') };
delete claudeEnv.CLAUDE_PLUGIN_ROOT;

/** @type {import('node:child_process').ChildProcess | null} */
let app = null;
try {
  // 1. Source
  let source = values.github ?? '';
  if (!source) {
    source = path.join(tmp, 'clone');
    const ref = values.ref ?? 'HEAD';
    const sha = sh('git', ['-C', root, 'rev-parse', ref]).out;
    checks.commit = sha;
    sh('git', ['clone', '--quiet', '--no-checkout', root, source]);
    sh('git', ['-C', source, 'checkout', '--quiet', sha]);
  }
  // 2. Install into an isolated Claude config
  const add = sh('claude', ['plugin', 'marketplace', 'add', source], { env: claudeEnv });
  say(add.out);
  const inst = sh('claude', ['plugin', 'install', 'qa-agent@qa-agent'], { env: claudeEnv });
  say(inst.out);
  const list = sh('claude', ['plugin', 'list'], { env: claudeEnv });
  say(list.out);
  checks.installed =
    inst.code === 0 && /qa-agent@qa-agent/.test(list.out) && /enabled/.test(list.out);
  // 3. Installed copy
  const cache = path.join(claudeEnv.CLAUDE_CONFIG_DIR, 'plugins/cache/qa-agent/qa-agent');
  const version = fs.existsSync(cache) ? (fs.readdirSync(cache)[0] ?? '') : '';
  const installed = path.join(cache, version);
  checks.version = version;
  const has = (/** @type {string} */ p) => fs.existsSync(path.join(installed, p));
  checks.layout = {
    noNodeModules: !has('node_modules'),
    noLocalArtifacts: !has('qa-artifacts') && !has('.serena'),
    bundle: has('bin/qa-agent.mjs'),
    skills: ['discover', 'plan', 'generate', 'run', 'report', 'full-test'].every((s) =>
      has(`skills/${s}/SKILL.md`),
    ),
    agent: has('agents/failure-analyzer.md'),
    hook: has('hooks/hooks.json') && has('hooks/guard-credentials.mjs'),
    runtime: has('src/generator/runtime/qa-agent.fixtures.ts'),
  };
  say(`installed layout: ${JSON.stringify(checks.layout)}`);

  // 4. Fresh target project using the installed engine
  const target = path.join(tmp, 'target');
  const example = path.join(root, 'examples/helpdesk-app');
  fs.mkdirSync(path.join(target, '.qa-agent'), { recursive: true });
  fs.cpSync(path.join(example, 'docs'), path.join(target, 'docs'), { recursive: true });
  fs.copyFileSync(path.join(example, 'server.mjs'), path.join(target, 'server.mjs'));
  fs.writeFileSync(
    path.join(target, 'package.json'),
    '{"name":"helpdesk-target","private":true,"type":"module"}\n',
  );
  const pw = JSON.parse(
    fs.readFileSync(path.join(root, 'node_modules/@playwright/test/package.json'), 'utf8'),
  ).version;
  const npmI = sh(
    'npm',
    ['install', '--no-audit', '--no-fund', '--save-exact', `@playwright/test@${pw}`],
    { cwd: target, shell: process.platform === 'win32' },
  );
  checks.targetDeps = npmI.code === 0 ? `@playwright/test@${pw} only` : 'npm install failed';
  // A separate process: the engine below runs with spawnSync, which would block an in-process server.
  const server = spawn(process.execPath, [path.join(target, 'server.mjs'), '0'], {
    env: { ...process.env, HELPDESK_TEST_MODE: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  app = server;
  /** @type {string} */
  const appUrl = await new Promise((resolve, reject) => {
    server.stdout?.on('data', (d) => {
      const m = /listening on (http:\/\/\S+)/.exec(String(d));
      if (m?.[1]) resolve(m[1]);
    });
    server.once('exit', () => reject(new Error('helpdesk app exited')));
  });
  const cfg = JSON.parse(fs.readFileSync(path.join(example, '.qa-agent/config.json'), 'utf8'));
  cfg.baseURL = `${appUrl}/`;
  cfg.allowedOrigins = [appUrl];
  fs.writeFileSync(path.join(target, '.qa-agent/config.json'), JSON.stringify(cfg, null, 2));
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    FORCE_COLOR: '0',
    QA_AGENT_BROWSER_CHANNEL: process.env.QA_AGENT_BROWSER_CHANNEL ?? 'chrome',
  };
  delete env.CLAUDE_PLUGIN_ROOT;
  for (const [k, u] of [
    ['CUSTOMER', 'carol'],
    ['AGENT', 'dan'],
    ['AUDITOR', 'erin'],
  ]) {
    env[`QA_AGENT_ACCOUNT_HELPDESK_${k}_USERNAME`] = `${u}@helpdesk.test`;
    env[`QA_AGENT_ACCOUNT_HELPDESK_${k}_PASSWORD`] = `${u}-helpdesk`;
  }
  const ft = sh(
    process.execPath,
    [path.join(installed, 'bin/qa-agent.mjs'), 'full-test', '--offline', '--project', target],
    { env, cwd: target, shell: false },
  );
  say(
    ft.out
      .split('\n')
      .filter((l) => /^(==| {3}|full-test)/.test(l))
      .join('\n'),
  );
  checks.fullTest = {
    exit: ft.code,
    report: /passed 17\/17, failed 0/.test(ft.out) ? 'passed 17/17' : 'not 17/17',
    typecheck: /type-check not run \(no TypeScript\)/.test(ft.out)
      ? 'not run (no TypeScript in target)'
      : /type-check ok/.test(ft.out)
        ? 'ok'
        : 'unknown',
  };
  checks.generatedIn = fs.existsSync(path.join(target, 'tests/qa/qa-agent.fixtures.ts'))
    ? 'tests/qa'
    : 'missing';

  const un = sh('claude', ['plugin', 'uninstall', 'qa-agent@qa-agent'], { env: claudeEnv });
  checks.uninstalled = un.code === 0;
  const layout = /** @type {Record<string, boolean>} */ (checks.layout);
  checks.pass =
    checks.installed === true &&
    Object.values(layout).every(Boolean) &&
    ft.code === 0 &&
    /passed 17\/17, failed 0/.test(ft.out) &&
    checks.uninstalled === true;
} catch (err) {
  checks.error = err instanceof Error ? err.message : String(err);
  checks.pass = false;
} finally {
  app?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
fs.mkdirSync(outDir, { recursive: true });
const name = values.github ? 'install-smoke-github' : 'install-smoke';
fs.writeFileSync(path.join(outDir, `${name}.json`), `${redact(JSON.stringify(checks, null, 2))}\n`);
fs.writeFileSync(path.join(outDir, `${name}.log`), `${log.join('\n')}\n`);
say(`${checks.pass ? 'PASS' : 'FAIL'}: evidence ${path.relative(root, outDir)}/${name}.{json,log}`);
process.exit(checks.pass ? 0 : 1);

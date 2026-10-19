#!/usr/bin/env node
// Release dry-run (P9-T05). Checks that a commit is releasable and builds the release artifact
// locally. It does NOT tag, push or publish: those need the owner's explicit request.
//
//   node scripts/release-dry-run.mjs [--ref HEAD] [--out evidence/P9]
//
// Checks: clean tree, version agreement (package.json, plugin manifest, marketplace entry,
// CHANGELOG), bundle freshness, `claude plugin validate`, secret scan of every tracked file,
// direct dependency licenses. Artifact: `git archive` of the ref (what a marketplace install
// clones) with size and SHA-256.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { ref: { type: 'string' }, out: { type: 'string' } } });
const ref = values.ref ?? 'HEAD';
const outDir = path.resolve(root, values.out ?? 'evidence/P9');
/** @type {{ name: string, ok: boolean, detail: string }[]} */
const checks = [];
const check = (
  /** @type {string} */ name,
  /** @type {boolean} */ ok,
  /** @type {string} */ detail,
) => checks.push({ name, ok, detail });
/** @param {string} cmd @param {string[]} args */
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};
const json = (/** @type {string} */ rel) =>
  JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

const sha = run('git', ['rev-parse', ref]).out;
const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']).out;
check('working tree has no uncommitted changes to tracked files', dirty === '', dirty || 'clean');

const pkg = json('package.json');
const manifest = json('.claude-plugin/plugin.json');
const market = json('.claude-plugin/marketplace.json');
const version = manifest.version;
const changelog = fs.existsSync(path.join(root, 'CHANGELOG.md'))
  ? fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  : '';
check(
  'versions agree (package.json, plugin.json, marketplace.json, CHANGELOG)',
  pkg.version === version &&
    market.plugins?.[0]?.version === version &&
    changelog.includes(`## ${version}`),
  `package ${pkg.version}, plugin ${version}, marketplace ${market.plugins?.[0]?.version}, CHANGELOG ${changelog.includes(`## ${version}`) ? 'has' : 'lacks'} "## ${version}"`,
);
const bundle = run(process.execPath, ['scripts/bundle.mjs', '--check']);
check('bin/qa-agent.mjs is built from the current src/', bundle.code === 0, bundle.out);
const validate = run('claude', ['plugin', 'validate', '.']);
check('claude plugin validate', validate.code === 0, validate.out.split('\n').at(-1) ?? '');

// Secret scan of the tracked tree at the ref (what would be distributed).
const files = run('git', ['ls-tree', '-r', '--name-only', ref]).out.split('\n').filter(Boolean);
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bsk-ant-[A-Za-z0-9-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/,
];
const PERSONAL = [
  /[A-Za-z]:\\Users\\(?!<USER>)[A-Za-z0-9._-]+\\/,
  /\/(?:home|Users)\/(?!<USER>)[a-z0-9._-]+\//,
];
/** @type {string[]} */
const hits = [];
for (const f of files) {
  const blob = run('git', ['show', `${ref}:${f}`]).out;
  for (const re of [...SECRET, ...PERSONAL])
    if (re.test(blob)) hits.push(`${f}: ${re.source.slice(0, 30)}`);
}
check(
  `secret / personal-path scan of ${files.length} tracked files`,
  hits.length === 0,
  hits.join('; ') || 'no matches',
);

/** @type {Record<string, string>} */
const licenses = {};
for (const d of [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]) {
  const p = path.join(root, 'node_modules', d, 'package.json');
  licenses[`${d}@${fs.existsSync(p) ? json(path.relative(root, p)).version : '?'}`] = fs.existsSync(
    p,
  )
    ? json(path.relative(root, p)).license
    : 'unknown';
}
const ALLOWED = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause']);
const bad = Object.entries(licenses).filter(([, l]) => !ALLOWED.has(l));
check(
  'direct dependency licenses are permissive',
  bad.length === 0,
  bad.map(([d, l]) => `${d}: ${l}`).join(', ') || Object.values(licenses).join(', '),
);
const projectLicense = fs.existsSync(path.join(root, 'LICENSE'))
  ? 'LICENSE present'
  : 'no LICENSE file (owner decision)';

// Artifact
fs.mkdirSync(outDir, { recursive: true });
const tarName = `qa-agent-${version}-${sha.slice(0, 7)}.tar.gz`;
const tarTmp = path.join(outDir, tarName);
const archive = run('git', [
  'archive',
  '--format=tar.gz',
  `--prefix=qa-agent-${version}/`,
  '-o',
  tarTmp,
  ref,
]);
const buf = fs.existsSync(tarTmp) ? fs.readFileSync(tarTmp) : Buffer.alloc(0);
const artifact = {
  name: tarName,
  bytes: buf.length,
  sha256: createHash('sha256').update(buf).digest('hex'),
  files: files.length,
};
fs.rmSync(tarTmp, { force: true }); // the artifact is rebuilt from the tag on release; only its digest is evidence
check(
  'release archive builds',
  archive.code === 0 && buf.length > 0,
  `${artifact.bytes} bytes, sha256 ${artifact.sha256}`,
);

const ok = checks.every((c) => c.ok);
const result = {
  generatedAt: new Date().toISOString(),
  ref,
  commit: sha,
  version,
  ok,
  checks,
  artifact,
  licenses,
  projectLicense,
  published: false,
  note: 'dry-run: nothing was tagged, pushed or published',
};
fs.writeFileSync(path.join(outDir, 'release-dry-run.json'), `${JSON.stringify(result, null, 2)}\n`);
for (const c of checks) process.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name} — ${c.detail}\n`);
process.stdout.write(
  `${ok ? 'DRY-RUN OK' : 'DRY-RUN FAILED'}: qa-agent ${version} @ ${sha.slice(0, 7)}; evidence ${path.relative(root, outDir)}/release-dry-run.json\n`,
);
process.exit(ok ? 0 : 1);

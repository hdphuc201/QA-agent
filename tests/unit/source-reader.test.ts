import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  isSecretFileName,
  readProjectSources,
  redactSecrets,
} from '../../src/discovery/source-reader.ts';

const temps: string[] = [];
after(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

function project(files: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa src reader '));
  temps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  return root;
}

// Fake secrets assembled at runtime so this file itself never contains a real-looking secret.
const fakeAws = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const fakeGh = ['ghp', '_', 'a'.repeat(30)].join('');

describe('source reader', () => {
  test('reads docs and source, skipping secrets, binaries and excluded folders', () => {
    const root = project({
      'docs/requirements.md': '# Requirements',
      'src/app.ts': 'export const x = 1;',
      'src/.env': 'DB_PASSWORD=hunter2',
      '.env.local': 'X=1',
      'src/keys/server.pem': 'key',
      'src/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'src/blob.dat': Buffer.from([1, 0, 2, 3]),
      'src/node_modules/lib/index.js': 'module.exports = 1',
      'src/test-results/trace.txt': 'x',
      'src/playwright/.auth/user.json': '{}',
      'src/credentials.json': '{}',
    });
    const r = readProjectSources(root, { docsPaths: ['docs'], sourcePaths: ['src', '.env.local'] });
    assert.deepEqual(
      r.files.map((f) => [f.path, f.kind]),
      [
        ['docs/requirements.md', 'doc'],
        ['src/app.ts', 'source'],
      ],
    );
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
    assert.deepEqual(reasons, {
      '.env.local': 'secret-file',
      'src/.env': 'secret-file',
      'src/blob.dat': 'binary',
      'src/credentials.json': 'secret-file',
      'src/keys/server.pem': 'secret-file',
      'src/logo.png': 'binary',
      'src/node_modules': 'excluded-dir',
      'src/playwright/.auth': 'excluded-dir',
      'src/test-results': 'excluded-dir',
    });
    const all = JSON.stringify(r);
    assert.ok(!all.includes('hunter2'));
  });

  test('redacts secret-looking values inside readable files', () => {
    const root = project({
      'src/config.js': `const cfg = { password: "s3cr3t-value", apiKey: 'abcd1234efgh' };\nconst aws = "${fakeAws}";\nconst gh = "${fakeGh}";`,
    });
    const [file] = readProjectSources(root, { docsPaths: [], sourcePaths: ['src'] }).files;
    assert.ok(file);
    assert.equal(file.redactions, 4);
    assert.ok(!file.content.includes('s3cr3t-value') && !file.content.includes('abcd1234efgh'));
    assert.ok(!file.content.includes(fakeAws) && !file.content.includes(fakeGh));
    assert.match(file.content, /password: "\[REDACTED\]"/);
  });

  test('redactSecrets handles private key blocks and JWTs', () => {
    const pk = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIB', '-----END RSA PRIVATE KEY-----'].join(
      '\n',
    );
    const jwt = ['eyJ', 'a'.repeat(12), '.', 'b'.repeat(12), '.', 'c'.repeat(12)].join('');
    const r = redactSecrets(`${pk}\nAuthorization: ${jwt}`);
    assert.equal(r.count, 2);
    assert.equal(r.text, '[REDACTED]\nAuthorization: [REDACTED]');
  });

  test('enforces size and count limits', () => {
    const root = project({
      'src/a.txt': 'a'.repeat(10),
      'src/b.txt': 'b'.repeat(10),
      'src/big.txt': 'x'.repeat(100),
    });
    const r = readProjectSources(
      root,
      { docsPaths: [], sourcePaths: ['src'] },
      { maxFileBytes: 50, maxFiles: 1, maxTotalBytes: 1000 },
    );
    assert.deepEqual(
      r.files.map((f) => f.path),
      ['src/a.txt'],
    );
    assert.deepEqual(
      r.skipped.map((s) => [s.path, s.reason]),
      [
        ['src/b.txt', 'limit-files'],
        ['src/big.txt', 'too-large'],
      ],
    );
    const r2 = readProjectSources(
      root,
      { docsPaths: [], sourcePaths: ['src'] },
      { maxFileBytes: 50, maxFiles: 10, maxTotalBytes: 15 },
    );
    assert.deepEqual(r2.skipped.find((s) => s.path === 'src/b.txt')?.reason, 'limit-bytes');
  });

  test('never leaves the project root (.. paths and symlinks)', (t) => {
    const outside = project({ 'secret.txt': 'outside data' });
    const root = project({ 'src/ok.txt': 'ok' });
    let r = readProjectSources(root, { docsPaths: ['../'], sourcePaths: ['src'] });
    assert.deepEqual(
      r.files.map((f) => f.path),
      ['src/ok.txt'],
    );
    assert.equal(r.skipped[0]?.reason, 'outside-root');
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'src', 'link.txt'), 'file');
    } catch {
      t.skip('symlinks need developer mode/admin on Windows');
      return;
    }
    r = readProjectSources(root, { docsPaths: [], sourcePaths: ['src'] });
    assert.ok(!JSON.stringify(r.files).includes('outside data'));
    assert.deepEqual(r.skipped, [{ path: 'src/link.txt', reason: 'outside-root' }]);
  });

  test('secret file name rules', () => {
    for (const n of [
      '.env',
      '.env.production',
      'id_rsa',
      'id_ed25519.pub',
      'tls.key',
      '.npmrc',
      'aws-credentials.json',
      'admin.storageState.json',
    ]) {
      assert.ok(isSecretFileName(n), n);
    }
    for (const n of ['env.ts', 'environment.md', 'keyboard.ts', 'README.md'])
      assert.ok(!isSecretFileName(n), n);
  });
});

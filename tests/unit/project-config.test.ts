import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ConfigError } from '../../src/config/paths.ts';
import {
  findSecretLikeKeys,
  loadProjectConfig,
  parseProjectConfig,
  projectConfigJsonSchema,
  writeAllowlist,
} from '../../src/config/project-config.schema.ts';

const minimal = {
  schemaVersion: 1,
  projectId: 'demo-app',
  baseURL: 'http://127.0.0.1:4100/',
  allowedOrigins: ['http://127.0.0.1:4100'],
};

const issues = (data: unknown): string => {
  try {
    parseProjectConfig(data, 'cfg.json');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.message;
  }
  assert.fail('expected ConfigError');
};

const temps: string[] = [];
after(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

describe('project config schema', () => {
  test('minimal config gets safe defaults', () => {
    const cfg = parseProjectConfig(minimal, 'cfg.json');
    assert.equal(cfg.environment, 'local');
    assert.equal(cfg.testOutputRoot, 'e2e/generated');
    assert.deepEqual(cfg.workers, { max: 1, writeHeavy: 1 });
    assert.deepEqual(cfg.exploration, { maxPages: 20, timeoutMs: 30_000, retries: 1 });
    assert.deepEqual(cfg.roles, []);
    assert.deepEqual(writeAllowlist(cfg), ['.qa-agent', 'e2e/generated', 'qa-artifacts']);
  });

  test('full config with roles, auth recipe and budgets', () => {
    const cfg = parseProjectConfig(
      {
        ...minimal,
        framework: 'node-http',
        docsPaths: ['docs'],
        sourcePaths: ['src', 'server.mjs'],
        readOnlyPaths: ['docs'],
        roles: [
          { name: 'requester', accountKey: 'demo.requester' },
          { name: 'approver', accountKey: 'demo.approver', description: 'Approves requests' },
        ],
        workers: { max: 2, writeHeavy: 1 },
        exploration: {
          maxPages: 5,
          authRole: 'requester',
          auth: {
            loginPath: '/login',
            usernameLabel: 'Username',
            passwordLabel: 'Password',
            submitButton: 'Sign in',
          },
        },
      },
      'cfg.json',
    );
    assert.equal(cfg.roles[1]?.accountKey, 'demo.approver');
    assert.equal(cfg.exploration.auth?.passwordLabel, 'Password');
  });

  test('rejects baseURL origin missing from allowedOrigins and malformed origins', () => {
    assert.match(
      issues({ ...minimal, allowedOrigins: ['http://localhost:4100'] }),
      /must include the baseURL origin http:\/\/127\.0\.0\.1:4100/,
    );
    assert.match(
      issues({ ...minimal, allowedOrigins: ['http://127.0.0.1:4100/', 'ftp://x'] }),
      /must be an origin/,
    );
    assert.match(issues({ ...minimal, baseURL: 'file:///etc/passwd' }), /baseURL/);
  });

  test('rejects absolute or traversing paths', () => {
    for (const p of ['/etc', 'C:\\Windows', '..\\secrets', 'docs/../../x', '\\\\server\\share']) {
      assert.match(
        issues({ ...minimal, docsPaths: [p] }),
        /docsPaths\.0: must (be relative|not contain "\.\.")/,
        p,
      );
    }
  });

  test('rejects credentials and unknown keys', () => {
    assert.match(
      issues({ ...minimal, roles: [{ name: 'a', accountKey: 'a', password: 'x' }] }),
      /must not contain credentials \(keys: roles\[0\]\.password\)/,
    );
    assert.match(issues({ ...minimal, apiKey: 'k' }), /keys: apiKey/);
    assert.match(issues({ ...minimal, unexpected: true }), /Unrecognized key/);
    assert.deepEqual(
      findSecretLikeKeys({ exploration: { auth: { passwordLabel: 'Password' } } }),
      [],
    );
    assert.deepEqual(findSecretLikeKeys({ db: { dbPassword: 'x' }, list: [{ authToken: 'y' }] }), [
      'db.dbPassword',
      'list[0].authToken',
    ]);
  });

  test('rejects duplicate roles, unknown authRole, bad budgets and wrong schemaVersion', () => {
    const r = { name: 'a', accountKey: 'a.b' };
    assert.match(issues({ ...minimal, roles: [r, r] }), /role names must be unique/);
    assert.match(issues({ ...minimal, exploration: { authRole: 'ghost' } }), /unknown role ghost/);
    assert.match(
      issues({ ...minimal, workers: { max: 1, writeHeavy: 2 } }),
      /must be <= workers\.max/,
    );
    assert.match(issues({ ...minimal, workers: { max: 50 } }), /workers\.max/);
    assert.match(issues({ ...minimal, schemaVersion: 2 }), /schemaVersion/);
  });

  test('loadProjectConfig reads from the project and returns null when absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa cfg '));
    temps.push(root);
    assert.equal(loadProjectConfig(root), null);
    fs.mkdirSync(path.join(root, '.qa-agent'));
    fs.writeFileSync(path.join(root, '.qa-agent', 'config.json'), JSON.stringify(minimal));
    assert.equal(loadProjectConfig(root)?.config.projectId, 'demo-app');
  });

  test('JSON Schema export covers every top-level field', () => {
    const schema = projectConfigJsonSchema() as {
      properties: Record<string, unknown>;
      required: string[];
    };
    assert.deepEqual(schema.required.sort(), [
      'allowedOrigins',
      'baseURL',
      'projectId',
      'schemaVersion',
    ]);
    assert.ok('workers' in schema.properties && 'roles' in schema.properties);
  });
});

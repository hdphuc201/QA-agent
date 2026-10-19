import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildStaticMap, regexRouteToPaths } from '../../src/discovery/project-map.ts';
import { readProjectSources, type ReadFile } from '../../src/discovery/source-reader.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sampleApp = path.join(repoRoot, 'examples/sample-app');
const file = (p: string, content: string, kind: 'doc' | 'source' = 'source'): ReadFile => ({
  path: p,
  kind,
  size: content.length,
  content,
  redactions: 0,
});

describe('static project map', () => {
  test('sample app: routes, API refs, forms, UI and roles with sources', () => {
    const { files } = readProjectSources(sampleApp, {
      docsPaths: ['docs'],
      sourcePaths: ['server.mjs'],
    });
    const map = buildStaticMap(files, ['requester', 'approver', 'viewer']);
    const routes = map.routes.map((r) => `${r.method} ${r.path}`);
    for (const r of [
      'GET /login',
      'POST /login',
      'GET /',
      'GET /requests/new',
      'POST /requests',
      'ANY /requests/:param',
      'ANY /requests/:param/approve',
      'GET /api/requests',
      'POST /api/requests/:param/approve',
      'POST /api/requests/:param/reject',
    ]) {
      assert.ok(routes.includes(r), `missing route ${r}`);
    }
    // The approve API is documented (docs) and implemented (regex in code): both sources are kept.
    const approve = map.routes.find((r) => r.path === '/api/requests/:param/approve');
    assert.deepEqual(
      new Set(approve?.sources.map((s) => s.file)),
      new Set(['docs/requirements.md', 'server.mjs']),
    );
    assert.equal(approve?.api, true);
    for (const r of map.routes) {
      assert.equal(r.provenance, 'source-derived');
      assert.ok(r.sources.every((s) => s.line > 0));
      assert.ok(r.confidence > 0 && r.confidence <= 1);
    }

    const login = map.forms.find((f) => f.action === '/login');
    assert.deepEqual(login?.fields, [
      { label: 'Username', name: 'username', type: 'text' },
      { label: 'Password', name: 'password', type: 'password' },
    ]);
    assert.deepEqual(login?.submit, ['Sign in']);
    assert.ok(
      map.forms.some(
        (f) => f.action === '/requests/:param/reject' && f.fields[0]?.label === 'Reason',
      ),
    );
    assert.ok(
      map.ui.some(
        (u) => u.role === 'link' && u.name === 'New request' && u.href === '/requests/new',
      ),
    );
    assert.ok(map.ui.some((u) => u.role === 'button' && u.name === 'Approve'));
    assert.deepEqual(
      map.roles.filter((r) => r.provenance === 'source-derived').map((r) => r.name),
      ['anonymous', 'approver', 'requester', 'viewer'],
    );
  });

  test('express-style and file-system routes', () => {
    const map = buildStaticMap([
      file(
        'src/server.ts',
        "app.get('/orders/{id}', h);\nrouter.post(\"/orders\", h);\nrouter.delete('/orders/:orderId', h);",
      ),
      file('pages/index.tsx', 'export default () => null'),
      file('pages/users/[id].tsx', ''),
      file('app/settings/page.tsx', ''),
      file('pages/_app.tsx', ''),
    ]);
    assert.deepEqual(
      map.routes.map((r) => `${r.method} ${r.path}`),
      [
        'GET /',
        'POST /orders',
        'DELETE /orders/:param',
        'GET /orders/:param',
        'GET /settings',
        'GET /users/:param',
      ],
    );
  });

  test('roles found only in code naming are hypothesized with low confidence', () => {
    const map = buildStaticMap([file('src/a.ts', "if (user.role === 'auditor') {}")], ['admin']);
    assert.deepEqual(map.roles, [
      {
        name: 'auditor',
        provenance: 'hypothesized',
        confidence: 0.4,
        sources: [{ file: 'src/a.ts', line: 1 }],
      },
    ]);
  });

  test('regex route conversion', () => {
    assert.deepEqual(regexRouteToPaths('^\\/requests\\/(REQ-\\d+)$'), ['/requests/:param']);
    assert.deepEqual(regexRouteToPaths('^\\/a\\/(\\d+)\\/(on|off)$'), [
      '/a/:param/on',
      '/a/:param/off',
    ]);
    assert.deepEqual(regexRouteToPaths('foo'), []);
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { parseProjectConfig } from '../../src/config/project-config.schema.ts';
import {
  assertWritable,
  WriteDeniedError,
  writeProjectFile,
} from '../../src/config/write-guard.ts';
import { mergeDiscovery, ProjectMapFileSchema } from '../../src/discovery/discover.ts';
import type { ExplorationResult, PageObservation } from '../../src/discovery/explorer.ts';
import { buildStaticMap } from '../../src/discovery/project-map.ts';

const temps: string[] = [];
after(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

const config = parseProjectConfig(
  {
    schemaVersion: 1,
    projectId: 'proj',
    baseURL: 'http://127.0.0.1:4100/',
    allowedOrigins: ['http://127.0.0.1:4100'],
    readOnlyPaths: ['docs', '.qa-agent/locked'],
    roles: [{ name: 'requester', accountKey: 'demo.requester' }],
  },
  'cfg.json',
);

const page = (
  id: string,
  p: string,
  as: string,
  elements: PageObservation['elements'],
): PageObservation => ({
  id,
  kind: 'page',
  provenance: 'observed',
  url: `http://127.0.0.1:4100${p}`,
  path: p,
  title: null,
  as,
  observedAt: '2026-10-19T00:00:00.000Z',
  via: 'browser_snapshot',
  elements,
});

describe('mergeDiscovery', () => {
  test('links static routes/ui/forms/roles to observations and adds observed-only routes', () => {
    const files = [
      {
        path: 'server.mjs',
        kind: 'source' as const,
        size: 1,
        redactions: 0,
        content:
          'if (m === \'GET\' && p === \'/login\') {}\nconst r = /^\\/items\\/(\\d+)$/.exec(p);\n`<form method="post" action="/login"><label>Username <input name="u"></label><button type="submit">Sign in</button></form>`',
      },
    ];
    const map = buildStaticMap(files, ['requester']);
    const exploration: ExplorationResult = {
      pages: [
        page('obs-001', '/login', 'anonymous', [
          { id: 'obs-001-e1', role: 'textbox', name: 'Username', locator: 'x' },
          { id: 'obs-001-e2', role: 'button', name: 'Sign in', locator: 'y' },
        ]),
        page('obs-002', '/items/7', 'requester', []),
        page('obs-003', '/help', 'requester', []),
      ],
      blocked: [
        {
          kind: 'blocked',
          url: 'https://x.example/',
          reason: 'origin not allowed',
          as: 'anonymous',
        },
      ],
      auth: { role: 'requester', status: 'signed-in', detail: 'landed on /' },
      toolCalls: [],
      serverVersion: null,
    };
    const out = ProjectMapFileSchema.parse(
      mergeDiscovery(
        config,
        { files, skipped: [], totalBytes: 1 },
        map,
        exploration,
        '2026-10-19T00:00:00.000Z',
      ),
    );
    const byPath = Object.fromEntries(out.routes.map((r) => [`${r.method} ${r.path}`, r]));
    assert.deepEqual(byPath['GET /login']?.observedIn, ['obs-001']);
    assert.deepEqual(byPath['ANY /items/:param']?.observedIn, ['obs-002']);
    assert.equal(byPath['GET /help']?.provenance, 'observed');
    assert.deepEqual(byPath['GET /help']?.sources, []);
    assert.deepEqual(out.ui.find((u) => u.name === 'Sign in')?.observedIn, ['obs-001-e2']);
    assert.deepEqual(out.forms[0]?.observedIn, ['obs-001']);
    assert.deepEqual(out.exploration.blocked, [
      { url: 'https://x.example/', reason: 'origin not allowed', as: 'anonymous' },
    ]);
    assert.match(out.exploration.note, /Observed behaviour is not required behaviour/);
  });

  test('static-only run is marked as not live', () => {
    const out = mergeDiscovery(
      config,
      { files: [], skipped: [], totalBytes: 0 },
      buildStaticMap([]),
      null,
      't',
    );
    assert.equal(out.exploration.live, false);
    assert.equal(out.exploration.pages, 0);
  });
});

describe('write guard', () => {
  test('allows the allowlist, denies everything else', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa write guard '));
    temps.push(root);
    writeProjectFile(root, config, '.qa-agent/discovery/x.json', '{}');
    assert.ok(fs.existsSync(path.join(root, '.qa-agent/discovery/x.json')));
    assert.ok(assertWritable(root, config, 'e2e/generated/a.spec.ts'));
    assert.ok(assertWritable(root, config, 'qa-artifacts/run/1.json'));
    for (const bad of [
      'src/app.ts',
      'docs/x.md',
      '.qa-agent/locked/a',
      '../outside.txt',
      'e2e/other/a.ts',
      path.join(os.tmpdir(), 'abs.txt'),
    ]) {
      assert.throws(() => assertWritable(root, config, bad), WriteDeniedError, bad);
    }
  });
});

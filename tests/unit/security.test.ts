import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { main } from '../../src/cli.ts';
import {
  assertEnvironmentAllowed,
  destructiveReason,
  PolicyError,
} from '../../src/config/policy.ts';
import { parseProjectConfig } from '../../src/config/project-config.schema.ts';
import { scrubArtifacts, secretVariants } from '../../src/evidence/scrub.ts';
import { readZip, writeZip, ZipError } from '../../src/evidence/zip.ts';
import { buildPlan } from '../../src/planning/planner.ts';
import { parseRequirementsDoc } from '../../src/planning/requirements.ts';

const temps: string[] = [];
after(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qa security '));
  temps.push(d);
  return d;
};
const SECRET = 'p@ss w0rd&"x';

describe('zip', () => {
  test('round trip keeps names and bytes; garbage is rejected', () => {
    const entries = [
      {
        name: 'trace.trace',
        data: Buffer.from('{"method":"fill","params":{"value":"abc"}}\n'.repeat(50)),
      },
      { name: 'resources/0a1b', data: Buffer.from([0, 1, 2, 255]) },
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ];
    const back = readZip(writeZip(entries));
    assert.deepEqual(
      back.map((e) => e.name),
      entries.map((e) => e.name),
    );
    back.forEach((e, i) => assert.ok(e.data.equals(entries[i]?.data ?? Buffer.alloc(1))));
    assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), ZipError);
  });
});

describe('artifact scrubber', () => {
  test('removes credential values from traces (raw, URL-encoded, JSON-escaped), nested zips, HTML embeds and text', () => {
    const dir = tmp();
    const trace = writeZip([
      {
        name: 'test.trace',
        data: Buffer.from(`{"method":"fill","params":{"value":${JSON.stringify(SECRET)}}}`),
      },
      {
        name: 'resources/body',
        data: Buffer.from(`username=alice&password=${encodeURIComponent(SECRET)}`),
      },
      {
        name: 'resources/form',
        data: Buffer.from(`password=${encodeURIComponent(SECRET).replace(/%20/g, '+')}`),
      },
    ]);
    fs.mkdirSync(path.join(dir, 'test-results-parallel/x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test-results-parallel/x/trace.zip'), trace);
    const report = writeZip([
      { name: 'data.json', data: Buffer.from(`{"step":"Fill ${SECRET}"}`) },
      { name: 'inner.zip', data: trace },
    ]);
    fs.mkdirSync(path.join(dir, 'html-parallel'));
    fs.writeFileSync(
      path.join(dir, 'html-parallel/index.html'),
      `<script>window.playwrightReportBase64 = "data:application/zip;base64,${report.toString('base64')}";</script>`,
    );
    fs.writeFileSync(
      path.join(dir, 'results-parallel.json'),
      JSON.stringify({ stdout: `typed ${SECRET}` }),
    );
    fs.writeFileSync(path.join(dir, 'screenshot.png'), Buffer.from(SECRET)); // binary images are out of scope

    const r = scrubArtifacts(dir, [SECRET]);
    assert.deepEqual(r.errors, []);
    assert.equal(r.filesChanged.length, 3);
    const all = (buf: Buffer): string =>
      readZip(buf)
        .map((e) => (e.name.endsWith('.zip') ? all(e.data) : e.data.toString('utf8')))
        .join('\n');
    const scrubbedTrace = all(fs.readFileSync(path.join(dir, 'test-results-parallel/x/trace.zip')));
    const html = fs.readFileSync(path.join(dir, 'html-parallel/index.html'), 'utf8');
    const embedded = all(Buffer.from(/base64,([^"]+)/.exec(html)?.[1] ?? '', 'base64'));
    for (const text of [
      scrubbedTrace,
      embedded,
      fs.readFileSync(path.join(dir, 'results-parallel.json'), 'utf8'),
    ]) {
      for (const v of secretVariants(SECRET)) assert.ok(!text.includes(v), `variant ${v} left`);
      assert.ok(text.includes('***'));
    }
    assert.match(scrubbedTrace, /"method":"fill"/, 'the trace structure is kept');
    assert.deepEqual(scrubArtifacts(dir, [SECRET]).replacements, 0, 'idempotent');
  });

  test('a corrupt archive is reported, not silently kept', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'trace.zip'), Buffer.from('PK broken'));
    const r = scrubArtifacts(dir, [SECRET]);
    assert.equal(r.errors.length, 1);
  });
});

describe('execution policies', () => {
  test('production is refused for live work unless explicitly allowed', () => {
    assert.throws(
      () => assertEnvironmentAllowed({ environment: 'production' }, {}, 'run tests'),
      PolicyError,
    );
    assert.doesNotThrow(() =>
      assertEnvironmentAllowed(
        { environment: 'production' },
        { QA_AGENT_ALLOW_PRODUCTION: '1' },
        'run tests',
      ),
    );
    assert.doesNotThrow(() =>
      assertEnvironmentAllowed({ environment: 'staging' }, {}, 'run tests'),
    );
  });

  test('destructive steps are recognised', () => {
    assert.equal(
      destructiveReason({ do: 'click', as: 'a', role: 'button', name: 'Delete account' }),
      'clicks "Delete account"',
    );
    assert.equal(
      destructiveReason({ do: 'click', as: 'a', role: 'button', name: 'Approve' }),
      null,
    );
    assert.equal(
      destructiveReason({
        kind: 'apiStatus',
        as: 'a',
        method: 'DELETE',
        path: '/api/x',
        status: 403,
      }),
      'sends DELETE /api/x',
    );
  });

  test('the planner blocks destructive cases unless policy.allowDestructive', () => {
    const base = {
      schemaVersion: 1,
      projectId: 'shop',
      baseURL: 'http://127.0.0.1:4100/',
      allowedOrigins: ['http://127.0.0.1:4100'],
      roles: [{ name: 'admin', accountKey: 'shop.admin' }],
    };
    const doc =
      '### SHOP-REQ-001 — Remove user\n- Actors: admin\n- When: the admin opens `/users/1` and clicks "Delete user"\n- Expected: the alert "User deleted" is shown';
    const plan = (allowDestructive: boolean) =>
      buildPlan({
        config: parseProjectConfig({ ...base, policy: { allowDestructive } }, 'c'),
        requirements: parseRequirementsDoc({ path: 'd.md', content: doc }),
        map: null,
        generatedAt: 't',
        requirementsFiles: [],
        projectMapPath: null,
      }).cases[0];
    assert.equal(plan(false)?.status, 'BLOCKED');
    assert.match(
      plan(false)?.blockers.join() ?? '',
      /destructive action \(clicks "Delete user"\) requires policy\.allowDestructive/,
    );
    assert.equal(plan(true)?.status, 'READY');
  });

  test('the CLI refuses live exploration of production, but a static (offline) discover is fine', async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.qa-agent'));
    fs.writeFileSync(
      path.join(root, '.qa-agent/config.json'),
      JSON.stringify({
        schemaVersion: 1,
        projectId: 'prod-app',
        environment: 'production',
        baseURL: 'https://shop.example.com/',
        allowedOrigins: ['https://shop.example.com'],
      }),
    );
    const out: string[] = [];
    const io = {
      out: (s: string) => out.push(s),
      err: (s: string) => out.push(s),
      env: {},
      cwd: root,
    };
    assert.equal(await main(['discover', '--project', root], io), 1);
    assert.match(out.join('\n'), /policy: refusing to explore against a production environment/);
    assert.equal(await main(['discover', '--project', root, '--offline'], io), 0);
  });
});

describe('portability (P8-T03)', () => {
  test('"appears on" checks the first generated value of the created record, whatever its field is', () => {
    const map = {
      ui: [{ role: 'link', name: 'Open a ticket', href: '/tickets/new' }],
      forms: [
        {
          fields: [
            { label: 'Subject', name: 'subject', type: 'text' },
            { label: 'Severity', name: 'severity', type: 'text' },
          ],
          submit: ['Submit ticket'],
        },
      ],
      routes: [],
    };
    const doc =
      '### HD-REQ-001 — Open\n- Actors: customer\n- When: the customer submits "Open a ticket" with a subject and a severity of 2\n- Expected: the ticket appears on the tickets page `/tickets`';
    const c = buildPlan({
      config: parseProjectConfig(
        {
          schemaVersion: 1,
          projectId: 'hd',
          baseURL: 'http://127.0.0.1:4200/',
          allowedOrigins: ['http://127.0.0.1:4200'],
          roles: [{ name: 'customer', accountKey: 'hd.customer' }],
        },
        'c',
      ),
      requirements: parseRequirementsDoc({ path: 'd.md', content: doc }),
      map: map as never,
      generatedAt: 't',
      requirementsFiles: [],
      projectMapPath: null,
    }).cases[0];
    assert.equal(c?.status, 'READY', c?.blockers.join());
    assert.match(JSON.stringify(c?.expectations), /"ref":"data\.subject"/);
  });
});

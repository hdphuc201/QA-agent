// Live P2 acceptance: sample app + real Playwright MCP (pinned in .mcp.json) + discover CLI.
// Skipped only when QA_AGENT_SKIP_LIVE=1 (reported as skipped, never as passed).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startSampleApp } from '../../examples/sample-app/server.mjs';
import { main } from '../../src/cli.ts';
import { ProjectMapFileSchema } from '../../src/discovery/discover.ts';
import { explore, startPlaywrightTools } from '../../src/discovery/explorer.ts';
import { parseProjectConfig } from '../../src/config/project-config.schema.ts';
import { copySampleApp } from '../helpers/sample-app.ts';

const skip = process.env.QA_AGENT_SKIP_LIVE === '1';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let app: { url: string; close: () => Promise<void> };
let project = '';

before(async () => {
  if (skip) return;
  app = await startSampleApp({ env: { SAMPLE_APP_TEST_MODE: '1' } });
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'qa live discover '));
  copySampleApp(project);
  const cfgFile = path.join(project, '.qa-agent/config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.baseURL = `${app.url}/`;
  cfg.allowedOrigins = [app.url];
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
});
after(async () => {
  if (skip) return;
  await app.close();
  fs.rmSync(project, { recursive: true, force: true });
});

const env = {
  ...process.env,
  QA_AGENT_ACCOUNT_DEMO_REQUESTER_USERNAME: 'alice',
  QA_AGENT_ACCOUNT_DEMO_REQUESTER_PASSWORD: 'alice-demo',
};

describe('P2 gate: live discovery of the sample app', { skip }, () => {
  test('discover writes a valid manifest; routes/elements trace back to observations; no secrets; no mutation', async () => {
    const out: string[] = [];
    const code = await main(['discover', '--project', project], {
      out: (s) => out.push(s),
      err: (s) => out.push(s),
      env,
      cwd: project,
    });
    assert.equal(code, 0, out.join('\n'));

    const mapText = fs.readFileSync(
      path.join(project, '.qa-agent/discovery/project-map.json'),
      'utf8',
    );
    const obsText = fs.readFileSync(
      path.join(project, '.qa-agent/discovery/observations.json'),
      'utf8',
    );
    const map = ProjectMapFileSchema.parse(JSON.parse(mapText));
    const obs = JSON.parse(obsText) as {
      pages: {
        id: string;
        path: string;
        as: string;
        elements: { id: string; role: string; name: string | null }[];
      }[];
    };

    assert.equal(map.exploration.live, true);
    assert.equal(map.exploration.auth?.status, 'signed-in');
    assert.ok(obs.pages.some((p) => p.as === 'requester' && p.path === '/requests/new'));
    assert.ok(
      obs.pages.some((p) => p.as === 'requester' && /^\/requests\/REQ-1$/.test(p.path)),
      'followed a link to a dynamic route',
    );

    // Traceability: route -> page observation; UI element -> observed element, both resolvable.
    const route = map.routes.find((r) => r.method === 'GET' && r.path === '/requests/new');
    assert.ok(
      route && route.observedIn.length > 0 && route.sources.some((s) => s.file === 'server.mjs'),
    );
    for (const id of route.observedIn)
      assert.ok(
        obs.pages.some((p) => p.id === id),
        id,
      );
    const link = map.ui.find((u) => u.role === 'link' && u.name === 'New request');
    assert.ok(link && link.observedIn.length > 0);
    const el = obs.pages.flatMap((p) => p.elements).find((e) => e.id === link.observedIn[0]);
    assert.deepEqual([el?.role, el?.name], ['link', 'New request']);

    // No secrets in outputs.
    for (const text of [mapText, obsText, out.join('\n')]) assert.ok(!text.includes('alice-demo'));

    // No unauthorized mutation: the server still holds exactly the seeded data.
    const login = await fetch(`${app.url}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'bob', password: 'bob-demo' }),
      redirect: 'manual',
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const all = (await (
      await fetch(`${app.url}/api/requests`, { headers: { cookie } })
    ).json()) as { id: string; status: string }[];
    assert.deepEqual(
      all.map((r) => [r.id, r.status]),
      [['REQ-1', 'Pending']],
    );

    // MCP artifacts stay in the allowlist.
    assert.ok(!fs.existsSync(path.join(project, '.playwright-mcp')));
  });

  test('URLs outside allowedOrigins are refused by QA Agent and by the MCP server', async () => {
    const raw = JSON.parse(fs.readFileSync(path.join(project, '.qa-agent/config.json'), 'utf8'));
    const config = parseProjectConfig(raw, 'cfg');
    const tools = await startPlaywrightTools({
      pluginRoot: repoRoot,
      projectRoot: project,
      config,
    });
    // Layer 2 (MCP --allowed-origins from the project config): direct call without QA Agent's guard.
    const direct = await tools.callTool('browser_navigate', { url: 'https://example.com/' });
    assert.equal(direct.isError, true, `MCP result: ${direct.text.slice(0, 500)}`);
    assert.match(direct.text, /ERR_BLOCKED_BY_CLIENT/);
    // Layer 1 (QA Agent guard): the URL never reaches the browser.
    const res = await explore({
      config,
      seeds: ['https://example.com/', 'file:///C:/Windows/win.ini', '/logout'],
      tools,
    });
    assert.deepEqual(
      res.blocked.map((b) => b.url),
      ['https://example.com/', 'file:///C:/Windows/win.ini', `${app.url}/logout`],
      JSON.stringify(res.blocked),
    );
    assert.ok(!res.toolCalls.some((c) => /example\.com|file:|logout/.test(c.target)));
  });
});

// P8-T03 gate: the whole pipeline on a second target app (examples/helpdesk-app) with other
// routing style, routes, labels, roles, wording and output folder. Nothing in the engine may be
// specific to examples/sample-app. Skipped only when QA_AGENT_SKIP_LIVE=1.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startHelpdeskApp } from '../../examples/helpdesk-app/server.mjs';
import { loadProjectConfig } from '../../src/config/project-config.schema.ts';
import { runFullTest } from '../../src/orchestrator/full-test.ts';
import { copyExampleApp, repoRoot } from '../helpers/sample-app.ts';

const skip = process.env.QA_AGENT_SKIP_LIVE === '1';
const env = {
  ...process.env,
  FORCE_COLOR: '0',
  QA_AGENT_BROWSER_CHANNEL: process.env.QA_AGENT_BROWSER_CHANNEL ?? 'chrome',
  QA_AGENT_ACCOUNT_HELPDESK_CUSTOMER_USERNAME: 'carol@helpdesk.test',
  QA_AGENT_ACCOUNT_HELPDESK_CUSTOMER_PASSWORD: 'carol-helpdesk',
  QA_AGENT_ACCOUNT_HELPDESK_AGENT_USERNAME: 'dan@helpdesk.test',
  QA_AGENT_ACCOUNT_HELPDESK_AGENT_PASSWORD: 'dan-helpdesk',
  QA_AGENT_ACCOUNT_HELPDESK_AUDITOR_USERNAME: 'erin@helpdesk.test',
  QA_AGENT_ACCOUNT_HELPDESK_AUDITOR_PASSWORD: 'erin-helpdesk',
};

let app: { url: string; close: () => Promise<void> };
let root = '';

before(async () => {
  if (skip) return;
  app = await startHelpdeskApp({ env: { HELPDESK_TEST_MODE: '1' } });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa second app '));
  copyExampleApp('helpdesk-app', root);
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"helpdesk-target","private":true}\n');
  const cfgFile = path.join(root, '.qa-agent/config.json');
  const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  raw.baseURL = `${app.url}/`;
  raw.allowedOrigins = [app.url];
  fs.writeFileSync(cfgFile, JSON.stringify(raw, null, 2));
});
after(async () => {
  if (skip) return;
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('P8 gate: second target app', { skip }, () => {
  test('discover → plan → generate → run → report passes every case of the helpdesk app', async () => {
    const config = loadProjectConfig(root)?.config;
    assert.ok(config);
    const lines: string[] = [];
    const r = await runFullTest({
      projectRoot: root,
      pluginRoot: repoRoot,
      config,
      env,
      offline: true,
      out: (s) => lines.push(s),
    });
    assert.equal(r.error, null, lines.join('\n'));
    const report = JSON.parse(
      fs.readFileSync(
        path.join(root, 'qa-artifacts/runs', r.state.runId ?? '', 'report/results.json'),
        'utf8',
      ),
    ) as { coverage: { counts: { executed: number; passed: number } } };
    assert.equal(report.coverage.counts.executed, 17, lines.join('\n'));
    assert.equal(report.coverage.counts.passed, 17, lines.join('\n'));

    // Output went to the configured folder; nothing of the first sample app leaked in.
    const out = path.join(root, 'tests/qa');
    const generated = fs.readdirSync(out).map((f) => fs.readFileSync(path.join(out, f), 'utf8'));
    assert.ok(generated.length >= 5);
    for (const text of generated)
      assert.doesNotMatch(text, /requester|approver|demo\.|4100|'Sign in'|\/login\b|data\.title/);
    assert.ok(!fs.existsSync(path.join(root, 'e2e')), 'no default output folder was created');
  });
});

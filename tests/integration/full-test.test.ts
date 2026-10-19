// P7: `qa-agent full-test` end to end (offline discovery to keep it quick), resume and recovery.
// Real Playwright run against the sample app. Skipped only when QA_AGENT_SKIP_LIVE=1.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startSampleApp } from '../../examples/sample-app/server.mjs';
import { main } from '../../src/cli.ts';
import type { FullTestState } from '../../src/orchestrator/full-test.ts';
import { copySampleApp, repoRoot } from '../helpers/sample-app.ts';

const skip = process.env.QA_AGENT_SKIP_LIVE === '1';
const env = {
  ...process.env,
  QA_AGENT_BROWSER_CHANNEL: process.env.QA_AGENT_BROWSER_CHANNEL ?? 'chrome',
  QA_AGENT_ACCOUNT_DEMO_REQUESTER_USERNAME: 'alice',
  QA_AGENT_ACCOUNT_DEMO_REQUESTER_PASSWORD: 'alice-demo',
  QA_AGENT_ACCOUNT_DEMO_APPROVER_USERNAME: 'bob',
  QA_AGENT_ACCOUNT_DEMO_APPROVER_PASSWORD: 'bob-demo',
  QA_AGENT_ACCOUNT_DEMO_VIEWER_USERNAME: 'victor',
  QA_AGENT_ACCOUNT_DEMO_VIEWER_PASSWORD: 'victor-demo',
};
let app: { url: string; close: () => Promise<void> };
let root = '';

before(async () => {
  if (skip) return;
  app = await startSampleApp({ env: { SAMPLE_APP_TEST_MODE: '1' } });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa full test '));
  copySampleApp(root);
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"sample-target","private":true}\n');
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

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await main([...args, '--project', root], {
    out: (s) => out.push(s),
    err: (s) => out.push(s),
    env,
    cwd: root,
  });
  return { code, out: out.join('\n') };
}
const state = () =>
  JSON.parse(
    fs.readFileSync(path.join(root, '.qa-agent/full-test-state.json'), 'utf8'),
  ) as FullTestState;

describe('P7: full-test pipeline', { skip }, () => {
  test('runs every stage and produces the report', async () => {
    const r = await cli('full-test', '--offline');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /full-test: all stages completed/);
    const s = state();
    assert.deepEqual(Object.keys(s.stages), ['discover', 'plan', 'generate', 'run', 'report']);
    assert.ok(s.runId);
    assert.match(s.stages.report?.summary ?? '', /passed 20\/20, failed 0, blocked 0/);
    for (const f of ['results.json', 'summary.md', 'report.html']) {
      assert.ok(fs.existsSync(path.join(root, 'qa-artifacts/runs', s.runId ?? '', 'report', f)), f);
    }
    assert.ok(
      fs.existsSync(
        path.join(root, 'qa-artifacts/runs', s.runId ?? '', 'html-parallel/index.html'),
      ),
      'Playwright HTML report',
    );
  });

  test('--resume skips finished stages with unchanged inputs', async () => {
    const before = state().runId;
    const r = await cli('full-test', '--offline', '--resume');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ran: report; resumed: discover, plan, generate, run/);
    assert.equal(state().runId, before, 'the previous run is reused, not repeated');
  });

  test('a failing stage stops the pipeline; --resume restarts from it once fixed', async () => {
    const reqFile = path.join(root, 'docs/requirements.md');
    const original = fs.readFileSync(reqFile, 'utf8');
    fs.writeFileSync(reqFile, '# Nothing testable\n');
    const broken = await cli('full-test', '--offline', '--resume');
    assert.equal(broken.code, 1);
    assert.match(broken.out, /stopped at plan: the plan has no READY case/);
    assert.deepEqual(Object.keys(state().stages), ['discover', 'plan']);
    assert.equal(state().stages.plan?.status, 'failed');

    fs.writeFileSync(reqFile, original);
    const fixed = await cli('full-test', '--offline', '--resume');
    assert.equal(fixed.code, 0, fixed.out);
    assert.match(fixed.out, /ran: discover, plan, generate, run, report/);
  });
});

// P5 acceptance: per-role contexts, tabs, session cache refresh, cleanup, two-role workflow through
// the scheduler, cancelled runs. Runs real Playwright (installed Chrome channel) against the sample app.
// Skipped only when QA_AGENT_SKIP_LIVE=1.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startSampleApp } from '../../examples/sample-app/server.mjs';
import { parseProjectConfig, type ProjectConfig } from '../../src/config/project-config.schema.ts';
import { runGenerate } from '../../src/generator/generate.ts';
import { resolveFromProject } from '../../src/generator/validate.ts';
import { runSuite } from '../../src/orchestrator/run.ts';
import { runDiscover } from '../../src/discovery/discover.ts';
import { runPlan } from '../../src/planning/plan-stage.ts';
import type { TestPlan } from '../../src/planning/schema.ts';
import { copySampleApp, repoRoot } from '../helpers/sample-app.ts';

const skip = process.env.QA_AGENT_SKIP_LIVE === '1';
const env = {
  ...process.env,
  FORCE_COLOR: '0',
  QA_AGENT_BROWSER_CHANNEL: process.env.QA_AGENT_BROWSER_CHANNEL ?? 'chrome',
  QA_AGENT_ACCOUNT_DEMO_REQUESTER_USERNAME: 'alice',
  QA_AGENT_ACCOUNT_DEMO_REQUESTER_PASSWORD: 'alice-demo',
  QA_AGENT_ACCOUNT_DEMO_APPROVER_USERNAME: 'bob',
  QA_AGENT_ACCOUNT_DEMO_APPROVER_PASSWORD: 'bob-demo',
  QA_AGENT_ACCOUNT_DEMO_VIEWER_USERNAME: 'victor',
  QA_AGENT_ACCOUNT_DEMO_VIEWER_PASSWORD: 'victor-demo',
};

// Custom (non-generated) spec exercising the runtime directly.
const SESSION_SPEC = `import { test, expect, resetTestData } from './qa-agent.fixtures';

test('S1 roles get isolated sessions; a second tab shares its role session', async ({ actors, browser }) => {
  await actors.login('requester');
  await actors.login('approver');
  const sid = async (role: string) => (await (await actors.context(role)).cookies()).find((c) => c.name === 'sid')?.value;
  const [r, a] = [await sid('requester'), await sid('approver')];
  expect(r).toBeTruthy();
  expect(a).toBeTruthy();
  expect(r).not.toBe(a);
  const tab = await actors.newTab('requester');
  await tab.goto('/');
  await expect(tab.getByTestId('current-user')).toHaveText('Signed in as Alice (requester)');
  const approver = await actors.page('approver');
  await approver.goto('/');
  await expect(approver.getByTestId('current-user')).toHaveText('Signed in as Bob (approver)');
  expect((await (await actors.request('anonymous')).get('/api/requests')).status()).toBe(401);
  expect(browser.contexts().length).toBe(3);
});

test('S2 no browser context leaks from the previous test', async ({ browser }) => {
  expect(browser.contexts().length).toBe(0);
});

test('S3 a cached session the server no longer accepts is refreshed by signing in', async ({ actors }) => {
  await actors.login('requester');
  expect(actors.sessionEvents).toEqual(['requester: reused']);
  await resetTestData(); // test mode: the server forgets every session
  const again = new (actors.constructor as new (...a: unknown[]) => typeof actors)(
    (await actors.context('requester')).browser(),
    (actors as unknown as { authDir: string }).authDir,
  );
  try {
    await again.login('requester');
    expect(again.sessionEvents).toEqual(['requester: expired', 'requester: signed-in']);
  } finally {
    await again.close();
  }
});

test('S4 an unexpectedly closed page/context fails loudly and is still cleaned up', async ({ actors }) => {
  const page = await actors.page('requester');
  await page.close();
  await expect(page.goto('/')).rejects.toThrow(/closed/);
  await (await actors.context('requester')).close();
});

test('S5 cleanup after a broken test', async ({ browser }) => {
  expect(browser.contexts().length).toBe(0);
});
`;

const GENERATED_SPECS = [
  'access-control.spec',
  'approval.spec',
  'authentication.spec',
  'requests.spec',
];

let app: { url: string; close: () => Promise<void> };
let root = '';
let config: ProjectConfig;
let plan: TestPlan;
let cli = '';

before(async () => {
  if (skip) return;
  app = await startSampleApp({ env: { SAMPLE_APP_TEST_MODE: '1' } });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa sessions '));
  copySampleApp(root);
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"sample-target","private":true}\n');
  const cfgFile = path.join(root, '.qa-agent/config.json');
  const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  raw.baseURL = `${app.url}/`;
  raw.allowedOrigins = [app.url];
  fs.writeFileSync(cfgFile, JSON.stringify(raw, null, 2));
  config = parseProjectConfig(raw, 'cfg');
  await runDiscover({ projectRoot: root, config, tools: null });
  plan = runPlan({ projectRoot: root, config }).plan;
  await runGenerate({
    projectRoot: root,
    config,
    plan,
    runtimeFile: path.join(repoRoot, 'src/generator/runtime/qa-agent.fixtures.ts'),
  });
  fs.writeFileSync(path.join(root, 'e2e/generated/qa-session-checks.spec.ts'), SESSION_SPEC);
  cli = resolveFromProject(root, '@playwright/test/cli') ?? '';
});
after(async () => {
  if (skip) return;
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Async on purpose: the sample app lives in this process, a sync spawn would deadlock it. */
async function playwright(args: string[], results: string) {
  const child = spawn(
    process.execPath,
    [
      cli,
      'test',
      '-c',
      path.join(root, 'e2e/generated/playwright.qa-agent.config.ts'),
      '--reporter=json',
      ...args,
    ],
    {
      cwd: root,
      env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: results },
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  const code = await new Promise<number | null>((r) => child.on('close', r));
  return {
    code,
    report: JSON.parse(fs.readFileSync(results, 'utf8')) as {
      stats: Record<string, number>;
      errors: unknown[];
    },
  };
}

describe('P5 gate: sessions, roles, orchestration', { skip }, () => {
  test('runtime: isolation, shared tabs, refresh of expired sessions, cleanup after errors', async () => {
    const res = await playwright(
      ['qa-session-checks', '--workers=1'],
      path.join(root, 'qa-artifacts/session-checks.json'),
    );
    assert.equal(res.code, 0, JSON.stringify(res.report.stats));
    assert.equal(res.report.stats.expected, 5);
    assert.equal(res.report.stats.unexpected, 0);
  });

  test('two-role workflow and forbidden actions pass through the scheduler (parallel + serial)', async () => {
    const out: string[] = [];
    const record = await runSuite({
      projectRoot: root,
      config,
      plan,
      env,
      out: (s) => out.push(s),
    });
    assert.equal(record.exitCode, 0, out.join(''));
    assert.deepEqual(
      record.phases.map((p) => [p.name, p.workers, p.cases]),
      [
        ['parallel', 2, 18],
        ['serial', 1, 1],
      ],
    );
    const parallel = JSON.parse(
      fs.readFileSync(path.join(root, record.phases[0]?.resultsFile ?? ''), 'utf8'),
    );
    const titles: string[] = [];
    const walk = (s: {
      specs?: { title: string; tests: { results: { status: string }[] }[] }[];
      suites?: unknown[];
    }) => {
      for (const sp of s.specs ?? [])
        if (sp.tests.every((t) => t.results.at(-1)?.status === 'passed'))
          titles.push(sp.title.split(' ')[0] ?? '');
      for (const c of (s.suites ?? []) as (typeof s)[]) walk(c);
    };
    parallel.suites.forEach(walk);
    for (const id of [
      'DEMO-REQ-APP-001-001',
      'DEMO-REQ-APP-003-001',
      'DEMO-REQ-APP-003-002',
      'DEMO-REQ-APP-003-004',
    ]) {
      assert.ok(titles.includes(id), `${id} passed`);
    }
    assert.ok(
      !fs.existsSync(path.join(root, 'qa-artifacts/auth')),
      'cached sessions purged after the run',
    );
  });

  test('a cancelled run (global timeout) stops cleanly and the next run is clean', async () => {
    const res = await playwright(
      ['--global-timeout=8000', '--workers=1', ...GENERATED_SPECS],
      path.join(root, 'qa-artifacts/cancelled.json'),
    );
    assert.notEqual(res.code, 0);
    const ran = res.report.stats.expected ?? 0;
    assert.ok(ran > 0, 'some tests ran before the timeout (the run really started)');
    assert.ok(ran < 19, 'not every test ran');
    // Playwright does not purge after an interrupted run; the next run's globalSetup and the engine do.
    const leftover = fs.existsSync(path.join(root, 'qa-artifacts/auth'));
    // A hard kill mid-run (no teardown at all) must not poison the next run either.
    const child = spawn(
      process.execPath,
      [
        cli,
        'test',
        '-c',
        path.join(root, 'e2e/generated/playwright.qa-agent.config.ts'),
        '--workers=1',
        ...GENERATED_SPECS,
      ],
      { cwd: root, env },
    );
    await new Promise((r) => setTimeout(r, 6000));
    child.kill();
    await new Promise((r) => child.on('close', r));
    const next = await runSuite({
      projectRoot: root,
      config,
      plan,
      env,
      out: () => undefined,
    });
    assert.equal(next.exitCode, 0);
    assert.ok(
      !fs.existsSync(path.join(root, 'qa-artifacts/auth')),
      `sessions purged by the next run (leftover after the cancelled run: ${leftover})`,
    );
  });
});

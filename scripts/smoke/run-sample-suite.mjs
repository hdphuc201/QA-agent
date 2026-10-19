#!/usr/bin/env node
// Runs the generated Playwright suite of examples/sample-app against a freshly started sample app.
// Usage: node scripts/smoke/run-sample-suite.mjs [--bug skip-approve-rbac] [--project <dir>]
//        [--port 4100] [--engine] [-- <extra playwright args>]
//   --engine  go through `qa-agent run` (scheduler: isolated cases in parallel, then serial ones)
// The demo credentials are fixture values of the local sample app, passed only via environment.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startSampleApp } from '../../examples/sample-app/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    bug: { type: 'string' },
    project: { type: 'string' },
    port: { type: 'string' },
    engine: { type: 'boolean' },
  },
});
const project = path.resolve(values.project ?? path.join(root, 'examples/sample-app'));
const port = Number(values.port ?? 4100);

const app = await startSampleApp({
  port,
  env: { SAMPLE_APP_TEST_MODE: '1', ...(values.bug ? { SAMPLE_APP_BUG: values.bug } : {}) },
});
process.stdout.write(
  `sample app ${app.url}${values.bug ? ` with intentional defect "${values.bug}"` : ''}\n`,
);

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
const args = values.engine
  ? [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      path.join(root, 'src/cli.ts'),
      'run',
      '--project',
      project,
    ]
  : [
      createRequire(path.join(project, 'package.json')).resolve('@playwright/test/cli'),
      'test',
      '-c',
      path.join(project, 'e2e/generated/playwright.qa-agent.config.ts'),
      ...positionals,
    ];
const child = spawn(process.execPath, args, { cwd: project, env, stdio: 'inherit' });
const code = await new Promise((resolve) => child.on('close', resolve));
await app.close();
process.stdout.write(`# ${values.engine ? 'qa-agent run' : 'playwright'} exit=${code}\n`);
process.exitCode = typeof code === 'number' ? code : 1;

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseProjectConfig } from '../../src/config/project-config.schema.ts';
import {
  explore,
  firstLine,
  maskValues,
  redirectTarget,
  type BrowserTools,
} from '../../src/discovery/explorer.ts';
import type { ToolResult } from '../../src/discovery/mcp-client.ts';
import { parseSnapshot, suggestLocator } from '../../src/discovery/snapshot.ts';
import { checkExplorationUrl, checkUrl } from '../../src/discovery/url-guard.ts';
import {
  accountEnvPrefix,
  requiredEnvVars,
  resolveCredentials,
} from '../../src/sessions/accounts.ts';

const ORIGIN = 'http://127.0.0.1:4100';
const config = (extra: Record<string, unknown> = {}) =>
  parseProjectConfig(
    {
      schemaVersion: 1,
      projectId: 'fake',
      baseURL: `${ORIGIN}/`,
      allowedOrigins: [ORIGIN],
      roles: [{ name: 'requester', accountKey: 'demo.requester' }],
      exploration: { retries: 1, timeoutMs: 1000, ...extra },
    },
    'cfg.json',
  );

const pageText = (url: string, title: string, yaml: string) =>
  `### Page\n- Page URL: ${url}\n- Page Title: ${title}\n### Snapshot\n\`\`\`yaml\n${yaml}\n\`\`\``;

/** Fake Playwright MCP: a map of path -> snapshot YAML, optional redirects, a login flow. */
function fakeBrowser(site: {
  pages: Record<string, string>;
  redirects?: Record<string, string>;
  failTimes?: Record<string, number>;
  errorTimes?: Record<string, { times: number; text: string }>;
  loginOk?: boolean;
}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let current = `${ORIGIN}/`;
  let signedIn = false;
  const failures = { ...site.failTimes };
  const tools: BrowserTools & { calls: typeof calls; closed: boolean } = {
    calls,
    closed: false,
    async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      calls.push({ name, args });
      if (name === 'browser_navigate') {
        const target = String(args.url);
        const left = failures[target] ?? 0;
        if (left > 0) {
          failures[target] = left - 1;
          throw new Error('transient failure');
        }
        const errSpec = site.errorTimes?.[target];
        if (errSpec && errSpec.times > 0) {
          errSpec.times--;
          return {
            text: `### Error
Error: ${errSpec.text}`,
            isError: true,
          };
        }
        const u = new URL(target);
        const redirect = site.redirects?.[u.pathname];
        current = redirect ? new URL(redirect, u).href : u.href;
        if (!signedIn && u.pathname === '/') current = `${ORIGIN}/login`;
        return { text: `### Page\n- Page URL: ${current}`, isError: false };
      }
      if (name === 'browser_snapshot') {
        const p = new URL(current).pathname;
        return {
          text: pageText(current, `T ${p}`, site.pages[p] ?? '- main [ref=e1]'),
          isError: false,
        };
      }
      if (name === 'browser_fill_form')
        return { text: 'filled with value s3cret-pass', isError: false };
      if (name === 'browser_click') {
        signedIn = site.loginOk !== false;
        current = signedIn ? `${ORIGIN}/` : `${ORIGIN}/login`;
        return { text: `### Page\n- Page URL: ${current}`, isError: false };
      }
      return { text: '', isError: false };
    },
    async close() {
      tools.closed = true;
    },
  };
  return tools;
}

const LOGIN_YAML = [
  '- heading "Sign in" [level=1] [ref=e1]',
  '- textbox "Username" [ref=e2]',
  '- textbox "Password" [ref=e3]',
  '- button "Sign in" [ref=e4]',
].join('\n');
const HOME_YAML = [
  '- heading "Requests" [level=1] [ref=e1]',
  '- link "Detail" [ref=e2] [cursor=pointer]:',
  '  - /url: /items/1',
  '- link "Leave" [ref=e3]:',
  '  - /url: https://evil.example/',
  '- link "Sign out" [ref=e4]:',
  '  - /url: /logout',
].join('\n');

describe('url guard', () => {
  test('allowlist, schemes, embedded credentials, unsafe GET paths', () => {
    assert.equal(checkUrl(`${ORIGIN}/x`, [ORIGIN]).allowed, true);
    assert.match(
      String((checkUrl('http://127.0.0.1:4101/', [ORIGIN]) as { reason: string }).reason),
      /not in allowedOrigins/,
    );
    assert.match(
      String((checkUrl('file:///etc/passwd', [ORIGIN]) as { reason: string }).reason),
      /scheme file:/,
    );
    assert.match(
      String((checkUrl('javascript:alert(1)', [ORIGIN]) as { reason: string }).reason),
      /scheme/,
    );
    assert.match(
      String((checkUrl(`http://u:p@127.0.0.1:4100/`, [ORIGIN]) as { reason: string }).reason),
      /credentials in URL/,
    );
    for (const p of ['/logout', '/users/1/delete', '/api/test/reset', '/sign-out']) {
      assert.equal(checkExplorationUrl(`${ORIGIN}${p}`, [ORIGIN]).allowed, false, p);
    }
    assert.equal(checkExplorationUrl(`${ORIGIN}/requests/new`, [ORIGIN]).allowed, true);
  });
});

describe('snapshot parser', () => {
  test('page header, roles, names, refs, levels, link urls and values', () => {
    const s = parseSnapshot(
      pageText(`${ORIGIN}/a`, 'Title A', `${HOME_YAML}\n- definition [ref=e9]: Pending`),
    );
    assert.equal(s.url, `${ORIGIN}/a`);
    assert.equal(s.title, 'Title A');
    assert.deepEqual(s.elements[0], {
      role: 'heading',
      name: 'Requests',
      ref: 'e1',
      level: 1,
      depth: 0,
    });
    assert.equal(s.elements.find((e) => e.name === 'Detail')?.href, '/items/1');
    assert.equal(s.elements.at(-1)?.text, 'Pending');
    assert.equal(
      suggestLocator({ role: 'button', name: 'Sign in' }),
      `getByRole('button', { name: "Sign in" })`,
    );
  });
});

describe('explorer (fake browser)', () => {
  test('crawls inside the allowlist, signs in with the recipe, masks the password', async () => {
    const tools = fakeBrowser({
      pages: { '/login': LOGIN_YAML, '/': HOME_YAML, '/items/1': '- heading "Item 1" [ref=e1]' },
    });
    const res = await explore({
      config: config({
        authRole: 'requester',
        auth: {
          loginPath: '/login',
          usernameLabel: 'Username',
          passwordLabel: 'Password',
          submitButton: 'Sign in',
        },
      }),
      seeds: [],
      credentials: { username: 'alice', password: 's3cret-pass' },
      tools,
    });
    assert.equal(res.auth?.status, 'signed-in');
    assert.deepEqual(
      res.pages.map((p) => `${p.as} ${p.path}`),
      ['anonymous /login', 'requester /', 'requester /items/1'],
    );
    assert.deepEqual(
      res.blocked.map((b) => b.reason),
      ['origin https://evil.example is not in allowedOrigins', 'path /logout looks state-changing'],
    );
    assert.ok(!JSON.stringify(res).includes('s3cret-pass'), 'password never stored');
    const fill = tools.calls.find((c) => c.name === 'browser_fill_form');
    assert.deepEqual(
      (fill?.args.fields as { target: string }[]).map((f) => f.target),
      ['e2', 'e3'],
    );
    assert.ok(
      tools.calls.every((c) =>
        ['browser_navigate', 'browser_snapshot', 'browser_fill_form', 'browser_click'].includes(
          c.name,
        ),
      ),
    );
    assert.ok(
      tools.calls.every(
        (c) => c.name !== 'browser_navigate' || String(c.args.url).startsWith(ORIGIN),
      ),
    );
    assert.equal(tools.closed, true);
    assert.ok(
      res.pages[1]?.elements.some(
        (e) => e.locator === `getByRole('heading', { name: "Requests" })`,
      ),
    );
  });

  test('no credentials: authenticated exploration is skipped, not faked', async () => {
    const tools = fakeBrowser({ pages: { '/login': LOGIN_YAML } });
    const res = await explore({
      config: config({
        authRole: 'requester',
        auth: {
          loginPath: '/login',
          usernameLabel: 'Username',
          passwordLabel: 'Password',
          submitButton: 'Sign in',
        },
      }),
      seeds: [],
      credentials: null,
      tools,
    });
    assert.deepEqual(res.auth, {
      role: 'requester',
      status: 'skipped',
      detail: 'no credentials in the environment for this role',
    });
    assert.ok(
      tools.calls.every((c) => c.name !== 'browser_fill_form' && c.name !== 'browser_click'),
    );
  });

  test('failed login is reported as failed', async () => {
    const tools = fakeBrowser({ pages: { '/login': LOGIN_YAML }, loginOk: false });
    const res = await explore({
      config: config({
        authRole: 'requester',
        auth: {
          loginPath: '/login',
          usernameLabel: 'Username',
          passwordLabel: 'Password',
          submitButton: 'Sign in',
        },
      }),
      seeds: [],
      credentials: { username: 'alice', password: 'wrong-pass' },
      tools,
    });
    assert.equal(res.auth?.status, 'failed');
    assert.ok(res.pages.every((p) => p.as === 'anonymous'));
  });

  test('redirect to a foreign origin is blocked and not observed', async () => {
    const tools = fakeBrowser({ pages: {}, redirects: { '/go': 'https://evil.example/landing' } });
    const res = await explore({ config: config(), seeds: ['/go'], tools });
    assert.deepEqual(res.blocked, [
      {
        kind: 'blocked',
        url: 'https://evil.example/landing',
        reason: `redirected outside allowedOrigins from ${ORIGIN}/go`,
        as: 'anonymous',
      },
    ]);
    assert.ok(res.pages.every((p) => !p.url.includes('evil')));
  });

  test('retries transient failures and respects maxPages', async () => {
    const tools = fakeBrowser({ pages: {}, failTimes: { [`${ORIGIN}/a`]: 1 } });
    const res = await explore({
      config: config({ maxPages: 2 }),
      seeds: ['/a', '/b', '/c'],
      tools,
    });
    assert.equal(res.pages.length, 2);
    assert.equal(
      tools.calls.filter((c) => c.name === 'browser_navigate' && c.args.url === `${ORIGIN}/a`)
        .length,
      2,
    );
  });

  test('anonymous exploration only uses navigate and snapshot', async () => {
    const tools = fakeBrowser({ pages: {} });
    await explore({ config: config(), seeds: [], tools });
    assert.ok(
      tools.calls.every((c) => c.name === 'browser_navigate' || c.name === 'browser_snapshot'),
    );
  });

  test('navigation error results: transient ones are retried, blocked ones are final', async () => {
    const tools = fakeBrowser({
      pages: { '/a': '- heading "A" [ref=e1]' },
      errorTimes: {
        [`${ORIGIN}/a`]: { times: 1, text: 'net::ERR_ABORTED' },
        [`${ORIGIN}/b`]: { times: 5, text: 'net::ERR_BLOCKED_BY_CLIENT at /b' },
      },
    });
    const res = await explore({ config: config({ retries: 2 }), seeds: ['/a', '/b'], tools });
    assert.ok(
      res.pages.some((p) => p.path === '/a'),
      'transient error retried',
    );
    const navB = tools.calls.filter(
      (c) => c.name === 'browser_navigate' && c.args.url === `${ORIGIN}/b`,
    );
    assert.equal(navB.length, 1, 'blocked navigation is not retried');
    assert.deepEqual(
      res.blocked.find((b) => b.url.endsWith('/b'))?.reason,
      'Error: net::ERR_BLOCKED_BY_CLIENT at /b',
    );
    assert.equal(firstLine(['### Error', 'Error: boom', 'Call log:'].join('\n')), 'Error: boom');
  });

  test('"interrupted by another navigation" is a redirect: followed inside the allowlist, blocked outside', async () => {
    const tools = fakeBrowser({
      pages: { '/login': LOGIN_YAML },
      errorTimes: {
        [`${ORIGIN}/r`]: {
          times: 1,
          text: `Navigation to "${ORIGIN}/r" is interrupted by another navigation to "${ORIGIN}/login"`,
        },
        [`${ORIGIN}/x`]: {
          times: 1,
          text: `Navigation to "${ORIGIN}/x" is interrupted by another navigation to "https://evil.example/"`,
        },
      },
    });
    const res = await explore({ config: config({ retries: 2 }), seeds: ['/r', '/x'], tools });
    const navR = tools.calls.filter(
      (c) => c.name === 'browser_navigate' && c.args.url === `${ORIGIN}/r`,
    );
    assert.equal(navR.length, 1, 'not retried');
    assert.ok(!res.blocked.some((b) => b.url.endsWith('/r')));
    assert.deepEqual(
      res.blocked.map((b) => [b.url, b.reason]),
      [['https://evil.example/', `redirected outside allowedOrigins from ${ORIGIN}/x`]],
    );
    assert.equal(
      redirectTarget('Navigation to "a" is interrupted by another navigation to "http://h/b"'),
      'http://h/b',
    );
    assert.equal(
      redirectTarget(
        'Navigation to "a" is interrupted by another navigation to "chrome-error://chromewebdata/"',
      ),
      null,
      'a browser error page is not a redirect',
    );
  });

  test('maskValues and account env resolution', () => {
    assert.equal(
      maskValues('fill("hunter22") then hunter22', ['hunter22']),
      'fill("***") then ***',
    );
    assert.equal(accountEnvPrefix('demo.requester'), 'QA_AGENT_ACCOUNT_DEMO_REQUESTER');
    assert.deepEqual(requiredEnvVars('a-b'), [
      'QA_AGENT_ACCOUNT_A_B_USERNAME',
      'QA_AGENT_ACCOUNT_A_B_PASSWORD',
    ]);
    assert.deepEqual(
      resolveCredentials('x', {
        QA_AGENT_ACCOUNT_X_USERNAME: 'u',
        QA_AGENT_ACCOUNT_X_PASSWORD: 'p',
      }),
      { username: 'u', password: 'p' },
    );
    assert.equal(resolveCredentials('x', { QA_AGENT_ACCOUNT_X_USERNAME: 'u' }), null);
  });
});

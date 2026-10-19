import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startSampleApp, validateRequest } from '../../examples/sample-app/server.mjs';

let app: { url: string; close: () => Promise<void> };
before(async () => {
  app = await startSampleApp({ env: { SAMPLE_APP_TEST_MODE: '1' } });
});
after(() => app.close());

async function login(username: string, password = `${username}-demo`): Promise<string> {
  const res = await fetch(`${app.url}/login`, {
    method: 'POST',
    body: new URLSearchParams({ username, password }),
    redirect: 'manual',
  });
  assert.equal(res.status, 303, `login ${username}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}
const api = (cookie: string, method: string, p: string, body?: unknown) =>
  fetch(`${app.url}${p}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('sample app fixture (behaves as docs/requirements.md says)', () => {
  test('AUTH-001/002/003: login, invalid login, anonymous redirect and 401', async () => {
    const cookie = await login('alice');
    const home = await (await fetch(`${app.url}/`, { headers: { cookie } })).text();
    assert.match(home, /<h1>Requests<\/h1>/);
    assert.match(home, /Signed in as Alice \(requester\)/);
    const bad = await fetch(`${app.url}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'alice', password: 'nope' }),
    });
    assert.equal(bad.status, 401);
    assert.match(await bad.text(), /role="alert">Invalid username or password/);
    const anon = await fetch(`${app.url}/`, { redirect: 'manual' });
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get('location'), '/login');
    assert.equal((await fetch(`${app.url}/api/requests`)).status, 401);
  });

  test('REQ-001..003: create, required title, amount boundaries', async () => {
    const cookie = await login('alice');
    const ok = await api(cookie, 'POST', '/api/requests', { title: 'Monitor', amount: 250 });
    assert.equal(ok.status, 201);
    assert.equal(((await ok.json()) as { status: string }).status, 'Pending');
    assert.deepEqual(validateRequest('', '5'), { ok: false, errors: ['Title is required'] });
    for (const a of [1, 10000]) assert.equal(validateRequest('x', String(a)).ok, true, String(a));
    for (const a of ['0', '10001', '1.5', '', 'abc']) {
      assert.deepEqual(
        validateRequest('x', a),
        { ok: false, errors: ['Amount must be a whole number between 1 and 10000'] },
        a,
      );
    }
  });

  test('APP-001..003 and VIEW-001: RBAC and decisions', async () => {
    const alice = await login('alice');
    const bob = await login('bob');
    const victor = await login('victor');
    const created = (await (
      await api(alice, 'POST', '/api/requests', { title: 'Chair', amount: 90 })
    ).json()) as { id: string };
    assert.equal((await api(alice, 'POST', `/api/requests/${created.id}/approve`)).status, 403);
    assert.equal((await api(victor, 'POST', `/api/requests/${created.id}/approve`)).status, 403);
    assert.equal(
      (await api(victor, 'POST', '/api/requests', { title: 'x', amount: 1 })).status,
      403,
    );
    const detailForAlice = await (
      await fetch(`${app.url}/requests/${created.id}`, { headers: { cookie: alice } })
    ).text();
    assert.doesNotMatch(detailForAlice, />Approve</);
    assert.equal(
      (await api(bob, 'POST', `/api/requests/${created.id}/reject`, { reason: '' })).status,
      400,
    );
    const approved = await api(bob, 'POST', `/api/requests/${created.id}/approve`);
    assert.equal(((await approved.json()) as { status: string }).status, 'Approved');
    const seen = (await (await api(alice, 'GET', `/api/requests/${created.id}`)).json()) as {
      status: string;
    };
    assert.equal(seen.status, 'Approved');
    assert.equal((await api(bob, 'POST', `/api/requests/${created.id}/approve`)).status, 409);
  });

  test('test reset only in test mode; intentional bug only when enabled', async () => {
    assert.equal((await fetch(`${app.url}/api/test/reset`, { method: 'POST' })).status, 204);
    const prod = await startSampleApp({ env: {} });
    const buggy = await startSampleApp({ env: { SAMPLE_APP_BUG: 'skip-approve-rbac' } });
    try {
      assert.equal((await fetch(`${prod.url}/api/test/reset`, { method: 'POST' })).status, 404);
      const res = await fetch(`${buggy.url}/login`, {
        method: 'POST',
        body: new URLSearchParams({ username: 'victor', password: 'victor-demo' }),
        redirect: 'manual',
      });
      const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const r = await fetch(`${buggy.url}/api/requests/REQ-1/approve`, {
        method: 'POST',
        headers: { cookie },
      });
      assert.equal(r.status, 200, 'the defect lets a viewer approve');
    } finally {
      await prod.close();
      await buggy.close();
    }
  });
});

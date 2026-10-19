#!/usr/bin/env node
// Sample target app for QA Agent: a tiny purchase-request approval workflow.
// Local fixture only (binds 127.0.0.1, in-memory data). Requirements: docs/requirements.md.
//
//   node examples/sample-app/server.mjs [port]
//   env SAMPLE_APP_TEST_MODE=1   enables POST /api/test/reset (test data reset)
//   env SAMPLE_APP_BUG=skip-approve-rbac   intentional defect for QA Agent self-tests (P6)
//
// Demo accounts (fixture data, not secrets): alice/requester, bob/approver, victor/viewer.
// Passwords come from SAMPLE_APP_PASSWORD_<USER> or default to "<user>-demo".

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {'requester' | 'approver' | 'viewer'} Role */
/** @typedef {{ username: string, name: string, role: Role, password: string }} User */
/** @typedef {'Pending' | 'Approved' | 'Rejected'} Status */
/** @typedef {{ id: string, title: string, amount: number, owner: string, status: Status, reason: string | null, decidedBy: string | null }} PurchaseRequest */

export const AMOUNT_MIN = 1;
export const AMOUNT_MAX = 10_000;
export const TITLE_MAX = 80;

/** @param {NodeJS.ProcessEnv} env @returns {User[]} */
function seedUsers(env) {
  /** @type {[string, string, Role][]} */
  const base = [
    ['alice', 'Alice', 'requester'],
    ['bob', 'Bob', 'approver'],
    ['victor', 'Victor', 'viewer'],
  ];
  return base.map(([username, name, role]) => ({
    username,
    name,
    role,
    password: env[`SAMPLE_APP_PASSWORD_${username.toUpperCase()}`] ?? `${username}-demo`,
  }));
}

/** @returns {PurchaseRequest[]} */
const seedRequests = () => [
  {
    id: 'REQ-1',
    title: 'Seeded laptop',
    amount: 1200,
    owner: 'alice',
    status: 'Pending',
    reason: null,
    decidedBy: null,
  },
];

/** @param {string} s */
const esc = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/**
 * Validates a new request. Messages are part of the requirements (DEMO-REQ-REQ-002/003).
 * @param {unknown} title @param {unknown} amountRaw
 * @returns {{ ok: true, title: string, amount: number } | { ok: false, errors: string[] }}
 */
export function validateRequest(title, amountRaw) {
  /** @type {string[]} */
  const errors = [];
  const t = typeof title === 'string' ? title.trim() : '';
  if (!t) errors.push('Title is required');
  else if (t.length > TITLE_MAX) errors.push(`Title must be at most ${TITLE_MAX} characters`);
  const a = typeof amountRaw === 'number' ? amountRaw : Number(String(amountRaw ?? '').trim());
  const amountOk =
    String(amountRaw ?? '').trim() !== '' &&
    Number.isInteger(a) &&
    a >= AMOUNT_MIN &&
    a <= AMOUNT_MAX;
  if (!amountOk)
    errors.push(`Amount must be a whole number between ${AMOUNT_MIN} and ${AMOUNT_MAX}`);
  return errors.length ? { ok: false, errors } : { ok: true, title: t, amount: a };
}

/**
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function createSampleApp(options = {}) {
  const env = options.env ?? process.env;
  const testMode = env.SAMPLE_APP_TEST_MODE === '1';
  const bug = env.SAMPLE_APP_BUG ?? '';
  const users = seedUsers(env);
  let requests = seedRequests();
  let nextId = 2;
  /** @type {Map<string, string>} sid -> username */
  const sessions = new Map();

  /** @param {http.IncomingMessage} req */
  const currentUser = (req) => {
    const sid = /(?:^|;\s*)sid=([a-f0-9]{32})/.exec(req.headers.cookie ?? '')?.[1];
    const username = sid ? sessions.get(sid) : undefined;
    return users.find((u) => u.username === username) ?? null;
  };

  /** @param {User} user @param {PurchaseRequest} r */
  const canSee = (user, r) => user.role !== 'requester' || r.owner === user.username;
  /** @param {User} user */
  const canDecide = (user) => bug === 'skip-approve-rbac' || user.role === 'approver';

  /** @param {string} title @param {string} body @param {User | null} user */
  const page = (title, body, user) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Sample Approvals</title></head>
<body>
<header>
  <nav aria-label="Main">
    <a href="/">Requests</a>
    ${user?.role === 'requester' ? '<a href="/requests/new">New request</a>' : ''}
  </nav>
  ${
    user
      ? `<p data-testid="current-user">Signed in as ${esc(user.name)} (${user.role})</p>
  <form method="post" action="/logout"><button type="submit">Sign out</button></form>`
      : ''
  }
</header>
<main>
${body}
</main>
</body></html>`;

  /** @param {http.ServerResponse} res @param {number} status @param {string} html @param {Record<string, string>} [headers] */
  const sendHtml = (res, status, html, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }).end(html);
  };
  /** @param {http.ServerResponse} res @param {number} status @param {unknown} data */
  const sendJson = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  };
  /** @param {http.ServerResponse} res @param {string} location */
  const redirect = (res, location) => res.writeHead(303, { location }).end();

  /** @param {http.IncomingMessage} req @returns {Promise<Record<string, string>>} */
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 10_000) {
          reject(new Error('body too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if ((req.headers['content-type'] ?? '').includes('application/json')) {
          try {
            const data = JSON.parse(raw || '{}');
            resolve(typeof data === 'object' && data !== null ? data : {});
          } catch {
            resolve({});
          }
        } else resolve(Object.fromEntries(new URLSearchParams(raw)));
      });
      req.on('error', reject);
    });

  const loginPage = (/** @type {string} */ error = '') => `<h1>Sign in</h1>
${error ? `<p role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/login">
  <label>Username <input name="username" autocomplete="username"></label>
  <label>Password <input name="password" type="password" autocomplete="current-password"></label>
  <button type="submit">Sign in</button>
</form>`;

  /** @param {User} user @param {string[]} errors @param {{ title?: string, amount?: string }} values */
  const newRequestPage = (user, errors = [], values = {}) =>
    page(
      'New request',
      `<h1>New request</h1>
${errors.map((e) => `<p role="alert">${esc(e)}</p>`).join('\n')}
<form method="post" action="/requests">
  <label>Title <input name="title" value="${esc(values.title ?? '')}"></label>
  <label>Amount <input name="amount" inputmode="numeric" value="${esc(values.amount ?? '')}"></label>
  <button type="submit">Create request</button>
</form>`,
      user,
    );

  /** @param {User} user @param {PurchaseRequest} r */
  const detailPage = (user, r) =>
    page(
      r.id,
      `<h1>${esc(r.title)}</h1>
<dl>
  <dt>ID</dt><dd data-testid="request-id">${r.id}</dd>
  <dt>Amount</dt><dd data-testid="request-amount">${r.amount}</dd>
  <dt>Requested by</dt><dd>${esc(r.owner)}</dd>
  <dt>Status</dt><dd data-testid="request-status">${r.status}</dd>
  ${r.reason ? `<dt>Reason</dt><dd data-testid="request-reason">${esc(r.reason)}</dd>` : ''}
  ${r.decidedBy ? `<dt>Decided by</dt><dd>${esc(r.decidedBy)}</dd>` : ''}
</dl>
${
  user.role === 'approver' && r.status === 'Pending'
    ? `<form method="post" action="/requests/${r.id}/approve"><button type="submit">Approve</button></form>
<form method="post" action="/requests/${r.id}/reject">
  <label>Reason <input name="reason"></label>
  <button type="submit">Reject</button>
</form>`
    : ''
}`,
      user,
    );

  /**
   * Shared decision logic for HTML forms and the JSON API (DEMO-REQ-APP-001..003).
   * @param {User} user @param {string} id @param {'approve' | 'reject'} action @param {string} reason
   * @returns {{ status: number, error?: string, request?: PurchaseRequest }}
   */
  const decide = (user, id, action, reason) => {
    const r = requests.find((x) => x.id === id);
    if (!r || !canSee(user, r)) return { status: 404, error: 'Request not found' };
    if (!canDecide(user))
      return { status: 403, error: 'You are not allowed to approve or reject requests' };
    if (r.status !== 'Pending') return { status: 409, error: `Request is already ${r.status}` };
    if (action === 'reject' && !reason.trim())
      return { status: 400, error: 'Reason is required to reject' };
    r.status = action === 'approve' ? 'Approved' : 'Rejected';
    r.reason = action === 'reject' ? reason.trim() : null;
    r.decidedBy = user.username;
    return { status: 200, request: r };
  };

  /** @param {User} user @param {Record<string, string>} body */
  const create = (user, body) => {
    if (user.role !== 'requester')
      return { status: 403, errors: ['Only requesters can create requests'] };
    const v = validateRequest(body.title, body.amount);
    if (!v.ok) return { status: 400, errors: v.errors };
    /** @type {PurchaseRequest} */
    const r = {
      id: `REQ-${nextId++}`,
      title: v.title,
      amount: v.amount,
      owner: user.username,
      status: 'Pending',
      reason: null,
      decidedBy: null,
    };
    requests.push(r);
    return { status: 201, request: r };
  };

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  const handle = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const m = req.method ?? 'GET';
    const user = currentUser(req);

    if (m === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });
    if (m === 'POST' && p === '/api/test/reset') {
      if (!testMode) return sendJson(res, 404, { error: 'Not found' });
      requests = seedRequests();
      nextId = 2;
      sessions.clear();
      return res.writeHead(204).end();
    }
    if (m === 'GET' && p === '/login')
      return sendHtml(res, 200, page('Sign in', loginPage(), null));
    if (m === 'POST' && p === '/login') {
      const body = await readBody(req);
      const u = users.find((x) => x.username === body.username && x.password === body.password);
      if (!u)
        return sendHtml(res, 401, page('Sign in', loginPage('Invalid username or password'), null));
      const sid = randomBytes(16).toString('hex');
      sessions.set(sid, u.username);
      return res
        .writeHead(303, {
          location: '/',
          'set-cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`,
        })
        .end();
    }
    if (m === 'POST' && p === '/logout') {
      const sid = /(?:^|;\s*)sid=([a-f0-9]{32})/.exec(req.headers.cookie ?? '')?.[1];
      if (sid) sessions.delete(sid);
      return res
        .writeHead(303, { location: '/login', 'set-cookie': 'sid=; Max-Age=0; Path=/' })
        .end();
    }

    // ---- JSON API (same session cookie)
    if (p.startsWith('/api/')) {
      if (!user) return sendJson(res, 401, { error: 'Authentication required' });
      if (m === 'GET' && p === '/api/me')
        return sendJson(res, 200, { username: user.username, role: user.role });
      if (m === 'GET' && p === '/api/requests')
        return sendJson(
          res,
          200,
          requests.filter((r) => canSee(user, r)),
        );
      if (m === 'POST' && p === '/api/requests') {
        const out = create(user, await readBody(req));
        return sendJson(res, out.status, out.request ?? { errors: out.errors });
      }
      const one = /^\/api\/requests\/(REQ-\d+)$/.exec(p);
      if (m === 'GET' && one?.[1]) {
        const r = requests.find((x) => x.id === one[1]);
        return r && canSee(user, r)
          ? sendJson(res, 200, r)
          : sendJson(res, 404, { error: 'Request not found' });
      }
      const act = /^\/api\/requests\/(REQ-\d+)\/(approve|reject)$/.exec(p);
      if (m === 'POST' && act?.[1] && (act[2] === 'approve' || act[2] === 'reject')) {
        const body = await readBody(req);
        const out = decide(user, act[1], act[2], String(body.reason ?? ''));
        return sendJson(res, out.status, out.request ?? { error: out.error });
      }
      return sendJson(res, 404, { error: 'Not found' });
    }

    // ---- HTML pages
    if (!user) return redirect(res, '/login');
    if (m === 'GET' && p === '/') {
      const visible = requests.filter((r) => canSee(user, r));
      const rows = visible
        .map(
          (r) =>
            `<tr><td><a href="/requests/${r.id}">${esc(r.title)}</a></td><td>${r.amount}</td><td>${esc(r.owner)}</td><td data-testid="status-${r.id}">${r.status}</td></tr>`,
        )
        .join('\n');
      return sendHtml(
        res,
        200,
        page(
          'Requests',
          `<h1>Requests</h1>
${visible.length ? `<table><thead><tr><th>Title</th><th>Amount</th><th>Requested by</th><th>Status</th></tr></thead><tbody>\n${rows}\n</tbody></table>` : '<p>No requests yet.</p>'}`,
          user,
        ),
      );
    }
    if (m === 'GET' && p === '/requests/new') {
      if (user.role !== 'requester')
        return sendHtml(
          res,
          403,
          page(
            'Forbidden',
            '<h1>Forbidden</h1><p role="alert">Only requesters can create requests</p>',
            user,
          ),
        );
      return sendHtml(res, 200, newRequestPage(user));
    }
    if (m === 'POST' && p === '/requests') {
      const body = await readBody(req);
      const out = create(user, body);
      if (out.request) return redirect(res, `/requests/${out.request.id}`);
      if (out.status === 403)
        return sendHtml(
          res,
          403,
          page(
            'Forbidden',
            `<h1>Forbidden</h1><p role="alert">${esc(out.errors?.[0] ?? '')}</p>`,
            user,
          ),
        );
      return sendHtml(
        res,
        400,
        newRequestPage(user, out.errors ?? [], {
          title: body.title ?? '',
          amount: body.amount ?? '',
        }),
      );
    }
    const detail = /^\/requests\/(REQ-\d+)$/.exec(p);
    if (m === 'GET' && detail?.[1]) {
      const r = requests.find((x) => x.id === detail[1]);
      if (!r || !canSee(user, r))
        return sendHtml(res, 404, page('Not found', '<h1>Not found</h1>', user));
      return sendHtml(res, 200, detailPage(user, r));
    }
    const formAct = /^\/requests\/(REQ-\d+)\/(approve|reject)$/.exec(p);
    if (m === 'POST' && formAct?.[1] && (formAct[2] === 'approve' || formAct[2] === 'reject')) {
      const body = await readBody(req);
      const out = decide(user, formAct[1], formAct[2], body.reason ?? '');
      if (out.request) return redirect(res, `/requests/${out.request.id}`);
      return sendHtml(
        res,
        out.status,
        page(
          'Not allowed',
          `<h1>Not allowed</h1><p role="alert">${esc(out.error ?? '')}</p>`,
          user,
        ),
      );
    }
    return sendHtml(res, 404, page('Not found', '<h1>Not found</h1>', user));
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  return server;
}

/**
 * Start on 127.0.0.1. Port 0 picks a free port.
 * @param {{ port?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startSampleApp(options = {}) {
  const server = createSampleApp(options.env ? { env: options.env } : {});
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string')
        return reject(new Error('unexpected address'));
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 4100);
  const app = await startSampleApp({ port });
  process.stdout.write(`sample app listening on ${app.url}\n`);
}

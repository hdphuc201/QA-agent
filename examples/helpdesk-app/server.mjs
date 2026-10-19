#!/usr/bin/env node
// Second target app for QA Agent (P8-T03): a tiny helpdesk. Deliberately different from
// examples/sample-app: Express-style routing, other routes, labels, roles and wording, so the
// pipeline is shown not to depend on the first app. Local fixture only (127.0.0.1, in-memory).
//
//   node examples/helpdesk-app/server.mjs [port]
//   env HELPDESK_TEST_MODE=1   enables POST /__qa/reset (test data reset)
//
// Demo accounts (fixture data, not secrets): carol@helpdesk.test/customer, dan@helpdesk.test/agent,
// erin@helpdesk.test/auditor. Passphrases default to "<name>-helpdesk".

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEVERITY_MIN = 1;
export const SEVERITY_MAX = 4;

/** @typedef {'customer' | 'agent' | 'auditor'} Role */
/** @typedef {{ email: string, name: string, role: Role, passphrase: string }} User */
/** @typedef {{ id: string, subject: string, severity: number, owner: string, state: 'Open' | 'Closed', resolution: string | null }} Ticket */

/** @param {NodeJS.ProcessEnv} env @returns {User[]} */
const seedUsers = (env) =>
  /** @type {[string, string, Role][]} */ ([
    ['carol', 'Carol', 'customer'],
    ['dan', 'Dan', 'agent'],
    ['erin', 'Erin', 'auditor'],
  ]).map(([id, name, role]) => ({
    email: `${id}@helpdesk.test`,
    name,
    role,
    passphrase: env[`HELPDESK_PASSPHRASE_${id.toUpperCase()}`] ?? `${id}-helpdesk`,
  }));

/** @returns {Ticket[]} */
const seedTickets = () => [
  {
    id: '1001',
    subject: 'Printer offline',
    severity: 2,
    owner: 'carol@helpdesk.test',
    state: 'Open',
    resolution: null,
  },
];

/** @param {string} s */
const esc = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/**
 * @param {unknown} subject @param {unknown} severityRaw
 * @returns {{ ok: true, subject: string, severity: number } | { ok: false, errors: string[] }}
 */
export function validateTicket(subject, severityRaw) {
  /** @type {string[]} */
  const errors = [];
  const s = typeof subject === 'string' ? subject.trim() : '';
  if (!s) errors.push('Subject is required');
  const n = Number(String(severityRaw ?? '').trim());
  const ok =
    String(severityRaw ?? '').trim() !== '' &&
    Number.isInteger(n) &&
    n >= SEVERITY_MIN &&
    n <= SEVERITY_MAX;
  if (!ok) errors.push(`Severity must be between ${SEVERITY_MIN} and ${SEVERITY_MAX}`);
  return errors.length ? { ok: false, errors } : { ok: true, subject: s, severity: n };
}

/** @typedef {import('node:http').IncomingMessage} Req */
/** @typedef {import('node:http').ServerResponse} Res */
/** @typedef {{ user: User, sid: string, params: Record<string, string> }} Ctx */
/** @typedef {(req: Req, res: Res, ctx: Ctx) => unknown} Handler */

/** Minimal Express-like router: app.get('/tickets/:id', handler). */
function createRouter() {
  /** @type {{ method: string, re: RegExp, keys: string[], fn: Handler }[]} */
  const routes = [];
  /** @param {string} method */
  const add = (method) => /** @param {string} pattern @param {Handler} fn */ (pattern, fn) => {
    /** @type {string[]} */
    const keys = [];
    const re = new RegExp(
      `^${pattern.replace(/:(\w+)/g, (_, /** @type {string} */ k) => (keys.push(k), '([^/]+)'))}$`,
    );
    routes.push({ method, re, keys, fn });
  };
  return {
    get: add('GET'),
    post: add('POST'),
    /** @param {string} method @param {string} p */
    match(method, p) {
      for (const r of routes) {
        const m = r.method === method ? r.re.exec(p) : null;
        if (m)
          return {
            fn: r.fn,
            params: Object.fromEntries(
              r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1] ?? '')]),
            ),
          };
      }
      return null;
    },
  };
}

/** @param {{ env?: NodeJS.ProcessEnv }} [options] */
export function createHelpdeskApp(options = {}) {
  const env = options.env ?? process.env;
  const testMode = env.HELPDESK_TEST_MODE === '1';
  const users = seedUsers(env);
  let tickets = seedTickets();
  let next = 1002;
  /** @type {Map<string, string>} sid → email */
  const sessions = new Map();

  /** @param {string} title @param {string} body @param {User | null} user */
  const layout = (title, body, user) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Helpdesk</title></head><body>
${
  user
    ? `<header><p>Logged in: ${esc(user.name)} (${user.role})</p>
<nav aria-label="Primary"><a href="/tickets">Tickets</a>${user.role === 'customer' ? ' <a href="/tickets/new">Open a ticket</a>' : ''}</nav>
<form method="post" action="/signout"><button type="submit">Log out</button></form></header>`
    : ''
}
<main>${body}</main></body></html>`;

  /** @param {Res} res @param {number} status @param {string} html */
  const send = (res, status, html) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  };
  /** @param {Res} res @param {number} status @param {unknown} data */
  const json = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  /** @param {Res} res @param {string} to @param {Record<string, string>} [headers] */
  const go = (res, to, headers = {}) => {
    res.writeHead(303, { location: to, ...headers });
    res.end();
  };
  /** @param {Req} req @returns {Promise<Record<string, string>>} */
  const readBody = async (req) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if ((req.headers['content-type'] ?? '').includes('application/json')) {
      try {
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    }
    return Object.fromEntries(new URLSearchParams(raw));
  };
  /** @param {User} user @param {Ticket} t */
  const visible = (user, t) => user.role !== 'customer' || t.owner === user.email;

  /** @param {string} [error] */
  const signinPage = (error) => `<h1>Log in to Helpdesk</h1>
${error ? `<p role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/signin">
  <label>Email <input name="email" type="email" autocomplete="username"></label>
  <label>Passphrase <input name="passphrase" type="password" autocomplete="current-password"></label>
  <button type="submit">Log in</button>
</form>`;
  /** @param {string[]} [errors] @param {Record<string, string>} [v] */
  const newPage = (errors = [], v = {}) => `<h1>Open a ticket</h1>
${errors.map((e) => `<p role="alert">${esc(e)}</p>`).join('\n')}
<form method="post" action="/tickets">
  <label>Subject <input name="subject" value="${esc(v.subject ?? '')}"></label>
  <label>Severity <input name="severity" inputmode="numeric" value="${esc(v.severity ?? '')}"></label>
  <button type="submit">Submit ticket</button>
</form>`;
  /** @param {User} user @param {Ticket} t */
  const ticketPage = (user, t) => `<h1>Ticket ${t.id}</h1>
<dl><dt>Subject</dt><dd>${esc(t.subject)}</dd><dt>Severity</dt><dd>${t.severity}</dd><dt>State</dt><dd>${t.state}</dd>
${t.resolution ? `<dt>Resolution</dt><dd>${esc(t.resolution)}</dd>` : ''}</dl>
${
  user.role === 'agent' && t.state === 'Open'
    ? `<form method="post" action="/tickets/${t.id}/close">
  <label>Resolution <input name="resolution"></label>
  <button type="submit">Close ticket</button>
</form>`
    : ''
}`;

  /** @param {User} user @param {Record<string, string>} body @returns {{ status: number, ticket?: Ticket, errors?: string[] }} */
  const create = (user, body) => {
    if (user.role !== 'customer')
      return { status: 403, errors: ['Only customers can open tickets'] };
    const v = validateTicket(body.subject, body.severity);
    if (!v.ok) return { status: 400, errors: v.errors };
    /** @type {Ticket} */
    const t = {
      id: String(next++),
      subject: v.subject,
      severity: v.severity,
      owner: user.email,
      state: 'Open',
      resolution: null,
    };
    tickets.push(t);
    return { status: 201, ticket: t };
  };
  /** @param {User} user @param {string} id @param {string | undefined} resolution @returns {{ status: number, ticket?: Ticket, error?: string }} */
  const close = (user, id, resolution) => {
    if (user.role !== 'agent') return { status: 403, error: 'Only agents can close tickets' };
    const t = tickets.find((x) => x.id === id);
    if (!t) return { status: 404, error: 'Ticket not found' };
    if (t.state !== 'Open') return { status: 409, error: 'Ticket is already closed' };
    const r = String(resolution ?? '').trim();
    if (!r) return { status: 400, error: 'A resolution is required' };
    t.state = 'Closed';
    t.resolution = r;
    return { status: 200, ticket: t };
  };

  const app = createRouter();
  app.post('/__qa/reset', (req, res) => {
    if (!testMode) return json(res, 404, { error: 'not found' });
    tickets = seedTickets();
    next = 1002;
    return json(res, 200, { ok: true });
  });
  app.get('/signin', (req, res) => send(res, 200, layout('Log in', signinPage(), null)));
  app.post('/signin', async (req, res) => {
    const body = await readBody(req);
    const user = users.find((u) => u.email === body.email && u.passphrase === body.passphrase);
    if (!user)
      return send(res, 401, layout('Log in', signinPage('Wrong email or passphrase'), null));
    const sid = randomBytes(16).toString('hex');
    sessions.set(sid, user.email);
    return go(res, '/tickets', { 'set-cookie': `hd_sid=${sid}; HttpOnly; SameSite=Lax; Path=/` });
  });
  app.post('/signout', (req, res, { sid }) => {
    sessions.delete(sid);
    return go(res, '/signin', { 'set-cookie': 'hd_sid=; Max-Age=0; Path=/' });
  });
  app.get('/', (req, res) => go(res, '/tickets'));
  app.get('/tickets', (req, res, { user }) => {
    const rows = tickets
      .filter((t) => visible(user, t))
      .map(
        (t) =>
          `<tr><td><a href="/tickets/${t.id}">${esc(t.subject)}</a></td><td>${t.state}</td></tr>`,
      )
      .join('');
    return send(
      res,
      200,
      layout(
        'Tickets',
        `<h1>Tickets</h1><table><thead><tr><th>Subject</th><th>State</th></tr></thead><tbody>${rows}</tbody></table>`,
        user,
      ),
    );
  });
  app.get('/tickets/new', (req, res, { user }) =>
    user.role === 'customer'
      ? send(res, 200, layout('Open a ticket', newPage(), user))
      : send(
          res,
          403,
          layout(
            'Forbidden',
            '<h1>Forbidden</h1><p role="alert">Only customers can open tickets</p>',
            user,
          ),
        ),
  );
  app.post('/tickets', async (req, res, { user }) => {
    const body = await readBody(req);
    const out = create(user, body);
    if (out.ticket) return go(res, `/tickets/${out.ticket.id}`);
    return send(res, out.status, layout('Open a ticket', newPage(out.errors, body), user));
  });
  app.get('/tickets/:id', (req, res, { user, params }) => {
    const t = tickets.find((x) => x.id === (params.id ?? ''));
    if (!t || !visible(user, t))
      return send(res, 404, layout('Not found', '<h1>Not found</h1>', user));
    return send(res, 200, layout(`Ticket ${t.id}`, ticketPage(user, t), user));
  });
  app.post('/tickets/:id/close', async (req, res, { user, params }) => {
    const out = close(user, params.id ?? '', (await readBody(req)).resolution);
    if (out.ticket) return go(res, `/tickets/${out.ticket.id}`);
    return send(
      res,
      out.status,
      layout(
        'Not allowed',
        `<h1>Not allowed</h1><p role="alert">${esc(out.error ?? '')}</p>`,
        user,
      ),
    );
  });
  app.get('/api/tickets', (req, res, { user }) =>
    json(
      res,
      200,
      tickets.filter((t) => visible(user, t)),
    ),
  );
  app.post('/api/tickets', async (req, res, { user }) => {
    const out = create(user, await readBody(req));
    return json(res, out.status, out.ticket ?? { errors: out.errors });
  });
  app.post('/api/tickets/:id/close', async (req, res, { user, params }) => {
    const out = close(user, params.id ?? '', (await readBody(req)).resolution);
    return json(res, out.status, out.ticket ?? { error: out.error });
  });

  const PUBLIC = new Set(['/signin', '/__qa/reset']);
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const sid = /(?:^|;\s*)hd_sid=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    const email = sessions.get(sid);
    const user = users.find((u) => u.email === email) ?? null;
    const hit = app.match(req.method ?? 'GET', url.pathname);
    if (!hit) return send(res, 404, layout('Not found', '<h1>Not found</h1>', user));
    if (!user && !PUBLIC.has(url.pathname)) {
      return url.pathname.startsWith('/api/')
        ? json(res, 401, { error: 'sign-in required' })
        : go(res, '/signin');
    }
    // Public routes never read `user`; every other route only runs signed in.
    const ctx = { user: /** @type {User} */ (user), sid, params: hit.params };
    Promise.resolve(hit.fn(req, res, ctx)).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
}

/**
 * Start on 127.0.0.1 (port 0 = free port).
 * @param {{ port?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startHelpdeskApp(options = {}) {
  const server = createHelpdeskApp(options.env ? { env: options.env } : {});
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string')
        return reject(new Error('unexpected address'));
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          /** @type {Promise<void>} */ (
            new Promise((done) => {
              server.closeAllConnections();
              server.close(() => done());
            })
          ),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 4200);
  const app = await startHelpdeskApp({ port });
  process.stdout.write(`helpdesk app listening on ${app.url}\n`);
}

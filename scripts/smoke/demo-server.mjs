// Local demo page for MCP smoke checks. Binds to 127.0.0.1 only, on an ephemeral port.
// Each start embeds a fresh random token so an observation cannot be produced without
// actually loading the page.

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * @param {{ port?: number }} [options]
 * @returns {Promise<{ url: string, token: string, close: () => Promise<void> }>}
 */
export function startDemoServer(options = {}) {
  const token = `qa-smoke-${randomBytes(6).toString('hex')}`;
  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>QA Agent Demo Page</title></head>
  <body>
    <main>
      <h1>QA Agent MCP Smoke</h1>
      <p>Smoke token: <strong data-testid="smoke-token">${token}</strong></p>
      <label>Name <input name="name" /></label>
      <button type="button">Submit</button>
    </main>
  </body>
</html>
`;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/' && req.url !== '/index.html')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('unexpected server address'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        token,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// `node scripts/smoke/demo-server.mjs [port]` serves until interrupted.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = await startDemoServer({ port: Number(process.argv[2] ?? 0) });
  process.stdout.write(`${JSON.stringify({ url: demo.url, token: demo.token })}\n`);
}

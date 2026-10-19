#!/usr/bin/env node
// Deterministic Playwright MCP smoke check (no AI involved):
// starts the server exactly as declared in the plugin's .mcp.json, speaks MCP JSON-RPC over
// stdio, loads a local demo page carrying a random token, and verifies the token appears in
// the accessibility snapshot. Also checks that a non-allowlisted origin is not loaded.
// Usage: node scripts/smoke/mcp-smoke.mjs [--plugin-root <dir>]   (exit 0 = pass)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startDemoServer } from './demo-server.mjs';

const REQUEST_TIMEOUT_MS = 180_000; // first run may download the pinned package and browser bits
const PROTOCOL_VERSION = '2025-06-18';

/** @typedef {{ command: string, args?: string[], env?: Record<string, string> }} StdioServer */

/** @param {string} pluginRoot @param {string} name @returns {StdioServer} */
export function readServerConfig(pluginRoot, name) {
  const raw = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  const servers = raw.mcpServers ?? raw;
  const server = servers[name];
  if (!server || typeof server.command !== 'string')
    throw new Error(`.mcp.json has no stdio server "${name}"`);
  const root = pluginRoot.replace(/\\/g, '/');
  /** @param {string} s */
  const sub = (s) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', root);
  return {
    command: sub(server.command),
    args: (server.args ?? []).map(sub),
    env: Object.fromEntries(Object.entries(server.env ?? {}).map(([k, v]) => [k, sub(String(v))])),
  };
}

/** @param {StdioServer} cfg */
function spawnServer(cfg) {
  const args = cfg.args ?? [];
  // On Windows `npx` is a .cmd shim and needs a shell. Only allow plain tokens through it.
  const needsShell = process.platform === 'win32' && /^(npx|npm)$/.test(cfg.command);
  if (needsShell) {
    for (const a of args) {
      if (!/^[\w@.:/*;=+-]+$/.test(a)) throw new Error(`unsafe argument for shell spawn: ${a}`);
    }
  }
  return spawn(cfg.command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: needsShell,
    env: { ...process.env, ...cfg.env },
    windowsHide: true,
  });
}

/** Minimal newline-delimited JSON-RPC client over a child's stdio. */
/** @param {import('node:child_process').ChildProcessWithoutNullStreams} child */
function rpcClient(child) {
  let nextId = 1;
  let buffer = '';
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      /** @type {any} */
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-protocol output
      }
      const entry = typeof msg.id === 'number' ? pending.get(msg.id) : undefined;
      if (!entry) continue;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    }
  });
  child.on('exit', (code) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`MCP server exited (code ${code})`));
    }
    pending.clear();
  });
  return {
    /** @param {string} method @param {unknown} params @returns {Promise<any>} */
    request(method, params) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
      });
    },
    /** @param {string} method @param {unknown} [params] */
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
  };
}

/** @param {any} result */
const textOf = (result) =>
  (result?.content ?? [])
    .filter((/** @type {any} */ c) => c.type === 'text')
    .map((/** @type {any} */ c) => c.text)
    .join('\n');

/** @param {string} pluginRoot @param {(line: string) => void} log */
export async function runSmoke(pluginRoot, log) {
  const cfg = readServerConfig(pluginRoot, 'playwright');
  log(`server: ${cfg.command} ${(cfg.args ?? []).join(' ')}`);
  const demo = await startDemoServer();
  log(`demo page: ${demo.url} (token ${demo.token})`);
  const child = spawnServer(cfg);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => (stderr += d));
  const rpc = rpcClient(child);
  /** @type {Record<string, unknown>} */
  const checks = {};
  try {
    const init = await rpc.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'qa-agent-mcp-smoke', version: '0.1.0' },
    });
    rpc.notify('notifications/initialized');
    checks.serverInfo = init.serverInfo;
    checks.protocolVersion = init.protocolVersion;
    log(`initialize: ${JSON.stringify(init.serverInfo)} protocol=${init.protocolVersion}`);

    const { tools } = await rpc.request('tools/list', {});
    const names = tools.map((/** @type {{ name: string }} */ t) => t.name).sort();
    checks.toolCount = names.length;
    log(`tools/list: ${names.length} tools: ${names.join(', ')}`);
    for (const required of ['browser_navigate', 'browser_snapshot', 'browser_close']) {
      if (!names.includes(required)) throw new Error(`missing tool ${required}`);
    }

    const nav = await rpc.request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: demo.url },
    });
    if (nav.isError) throw new Error(`browser_navigate failed: ${textOf(nav)}`);
    const snap = await rpc.request('tools/call', { name: 'browser_snapshot', arguments: {} });
    const snapshot = textOf(snap);
    checks.tokenInSnapshot = snapshot.includes(demo.token);
    checks.headingInSnapshot = snapshot.includes('QA Agent MCP Smoke');
    log(`browser_snapshot (${snapshot.length} chars):\n${snapshot}`);
    if (!checks.tokenInSnapshot) throw new Error('smoke token not found in snapshot');

    // Origin allowlist (a guardrail, not a security boundary): example.com must not load.
    const blocked = await rpc.request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: 'https://example.com/' },
    });
    const blockedText = textOf(blocked);
    checks.foreignOriginLoaded = !blocked.isError && /Example Domain/.test(blockedText);
    log(
      `navigate https://example.com/: isError=${Boolean(blocked.isError)}\n${blockedText.slice(0, 600)}`,
    );
    if (checks.foreignOriginLoaded) throw new Error('non-allowlisted origin was loaded');

    await rpc.request('tools/call', { name: 'browser_close', arguments: {} });
    checks.result = 'PASS';
    return checks;
  } catch (err) {
    checks.result = 'FAIL';
    checks.error = err instanceof Error ? err.message : String(err);
    if (stderr) log(`server stderr:\n${stderr.slice(-4000)}`);
    return checks;
  } finally {
    child.stdin.end();
    child.kill();
    await demo.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'plugin-root': { type: 'string' } } });
  const pluginRoot = path.resolve(
    values['plugin-root'] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  );
  const checks = await runSmoke(pluginRoot, (line) => process.stdout.write(`${line}\n`));
  process.stdout.write(`RESULT ${JSON.stringify(checks)}\n`);
  process.exitCode = checks.result === 'PASS' ? 0 : 1;
}

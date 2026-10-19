// Minimal MCP stdio client (newline-delimited JSON-RPC) for the plugin's Playwright MCP server.
// Used by the deterministic discovery engine; no AI involved.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface StdioServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

/** Read `<pluginRoot>/.mcp.json` server `name`, substituting `${CLAUDE_PLUGIN_ROOT}`. */
export function readServerConfig(pluginRoot: string, name = 'playwright'): StdioServerConfig {
  const raw = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8')) as {
    mcpServers?: Record<string, unknown>;
  };
  const servers: Record<string, unknown> = raw.mcpServers ?? (raw as Record<string, unknown>);
  const server = servers[name] as { command?: unknown; args?: unknown; env?: unknown } | undefined;
  if (!server || typeof server.command !== 'string')
    throw new Error(`.mcp.json has no stdio server "${name}"`);
  const root = pluginRoot.replace(/\\/g, '/');
  const sub = (s: string) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', root);
  return {
    command: sub(server.command),
    args: (Array.isArray(server.args) ? server.args : []).map((a) => sub(String(a))),
    env: Object.fromEntries(
      Object.entries((server.env ?? {}) as Record<string, unknown>).map(([k, v]) => [
        k,
        sub(String(v)),
      ]),
    ),
  };
}

/** Replace (or append) the value of `--flag value` in an argument list. */
export function withFlag(args: string[], flag: string, value: string): string[] {
  const i = args.indexOf(flag);
  if (i >= 0 && i + 1 < args.length) return [...args.slice(0, i + 1), value, ...args.slice(i + 2)];
  return [...args, flag, value];
}

const SAFE_SHELL_ARG = /^[\w@.:/\\*;=+ -]+$/;

export class McpClient {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private stderr = '';
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timeoutMs: number;
  private constructor(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      this.stderr = (this.stderr + d).slice(-8000);
    });
    child.on('exit', (code) => this.failAll(new Error(`MCP server exited (code ${code})`)));
    child.on('error', (err) => this.failAll(err));
  }

  /** Spawn and initialise. On Windows, `npx`/`npm` shims need a shell; arguments are whitelisted. */
  static async start(
    cfg: StdioServerConfig,
    options: { cwd: string; timeoutMs: number },
  ): Promise<McpClient> {
    const needsShell = process.platform === 'win32' && /^(npx|npm)$/.test(cfg.command);
    let args = cfg.args;
    if (needsShell) {
      for (const a of args)
        if (!SAFE_SHELL_ARG.test(a)) throw new Error(`unsafe argument for shell spawn: ${a}`);
      args = args.map((a) => (/[ ;]/.test(a) ? `"${a}"` : a));
    }
    const child = spawn(cfg.command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell,
      env: { ...process.env, ...cfg.env },
      windowsHide: true,
    });
    const client = new McpClient(child, options.timeoutMs);
    // First start may download the pinned package: allow extra time for initialize.
    await client.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'qa-agent', version: '0.1.0' },
      },
      Math.max(options.timeoutMs, 180_000),
    );
    client.notify('notifications/initialized');
    return client;
  }

  get serverStderr(): string {
    return this.stderr;
  }

  request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs} ms waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async listTools(): Promise<string[]> {
    const res = (await this.request('tools/list', {})) as { tools: { name: string }[] };
    return res.tools.map((t) => t.name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const res = (await this.request('tools/call', { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    return { text, isError: res.isError === true };
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    if (this.child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.child.kill();
          resolve();
        }, 3000);
        this.child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let msg: { id?: unknown; result?: unknown; error?: { code: number; message: string } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    }
  }

  private failAll(err: Error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }
}

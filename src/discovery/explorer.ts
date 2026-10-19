// Live, read-mostly exploration through Playwright MCP inside `allowedOrigins`.
// Tool policy: navigate / snapshot / close only — plus fill + click for the configured login
// recipe. Every URL (requested and post-redirect) is checked against the allowlist.

import type { ProjectConfig } from '../config/project-config.schema.ts';
import { McpClient, readServerConfig, withFlag, type ToolResult } from './mcp-client.ts';
import { parseSnapshot, suggestLocator, type SnapshotElement } from './snapshot.ts';
import { checkExplorationUrl, checkUrl } from './url-guard.ts';

export interface Credentials {
  username: string;
  password: string;
}

export interface ObservedElement {
  id: string;
  role: string;
  name: string | null;
  level?: number;
  href?: string;
  text?: string;
  locator: string;
}

export interface PageObservation {
  id: string;
  kind: 'page';
  provenance: 'observed';
  url: string;
  path: string;
  title: string | null;
  as: string; // 'anonymous' or a role name
  observedAt: string;
  via: 'browser_snapshot';
  elements: ObservedElement[];
}

export interface BlockedObservation {
  kind: 'blocked';
  url: string;
  reason: string;
  as: string;
}

export interface ExplorationResult {
  pages: PageObservation[];
  blocked: BlockedObservation[];
  auth: { role: string; status: 'signed-in' | 'skipped' | 'failed'; detail: string } | null;
  toolCalls: { tool: string; target: string }[];
  serverVersion: string | null;
}

/** Minimal tool surface the explorer needs; injectable for tests. */
export interface BrowserTools {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export const LAUNCH_TIMEOUT_MS = 120_000;

const ALLOWED_TOOLS = new Set([
  'browser_navigate',
  'browser_snapshot',
  'browser_close',
  'browser_fill_form',
  'browser_click',
]);

export class ToolPolicyError extends Error {
  override name = 'ToolPolicyError';
}

/** Replace every occurrence of the given secret values. */
export function maskValues(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 3) out = out.split(s).join('***');
  return out;
}

export interface ExploreOptions {
  config: ProjectConfig;
  /** Absolute or root-relative paths to visit first (e.g. GET routes from the static map). */
  seeds: string[];
  credentials?: Credentials | null;
  tools: BrowserTools;
  now?: () => Date;
}

export async function explore(options: ExploreOptions): Promise<ExplorationResult> {
  const { config, tools } = options;
  const origins = config.allowedOrigins;
  const base = new URL(config.baseURL);
  const now = options.now ?? (() => new Date());
  const secrets = options.credentials ? [options.credentials.password] : [];
  const result: ExplorationResult = {
    pages: [],
    blocked: [],
    auth: null,
    toolCalls: [],
    serverVersion: null,
  };
  const { timeoutMs, retries, maxPages } = config.exploration;
  let loginFlowActive = false;
  let browserStarted = false;

  const call = async (
    tool: string,
    args: Record<string, unknown>,
    target: string,
  ): Promise<ToolResult> => {
    if (!ALLOWED_TOOLS.has(tool))
      throw new ToolPolicyError(`tool ${tool} is not allowed during exploration`);
    if ((tool === 'browser_fill_form' || tool === 'browser_click') && !loginFlowActive) {
      throw new ToolPolicyError(`${tool} is only allowed for the configured login recipe`);
    }
    result.toolCalls.push({ tool, target: maskValues(target, secrets) });
    let lastErr: unknown;
    let lastResult: ToolResult | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // The first call launches the browser, which is slow on a loaded machine: allow at least 2 min.
        const limit = browserStarted ? timeoutMs : Math.max(timeoutMs, LAUNCH_TIMEOUT_MS);
        const r = await withTimeout(tools.callTool(tool, args), limit, tool);
        browserStarted = true;
        lastResult = { text: maskValues(r.text, secrets), isError: r.isError };
        // A navigation error right after another failed navigation is often transient
        // (aborted load); blocked origins are final and must not be retried.
        if (
          r.isError &&
          tool === 'browser_navigate' &&
          !/ERR_BLOCKED_BY_CLIENT/.test(r.text) &&
          !redirectTarget(r.text) &&
          attempt < retries
        )
          continue;
        return lastResult;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastResult) return lastResult;
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };

  let as = 'anonymous';
  let counter = 0;
  const visited = new Set<string>();
  const queue: string[] = [];
  const enqueue = (raw: string) => {
    let abs: URL;
    try {
      abs = new URL(raw, base);
    } catch {
      return;
    }
    abs.hash = '';
    const key = `${as} ${abs.href}`;
    if (visited.has(key) || queue.includes(abs.href)) return;
    queue.push(abs.href);
  };

  const visit = async (href: string): Promise<SnapshotElement[] | null> => {
    const d = checkExplorationUrl(href, origins);
    if (!d.allowed) {
      result.blocked.push({ kind: 'blocked', url: href, reason: d.reason, as });
      return null;
    }
    visited.add(`${as} ${href}`);
    const nav = await call('browser_navigate', { url: href }, href);
    // A server redirect can surface as "interrupted by another navigation to <target>": that is a
    // redirect, not a failure. The target still goes through the allowlist check below.
    const redirectedTo = nav.isError ? redirectTarget(nav.text) : null;
    const landed = redirectedTo ?? parseSnapshot(nav.text).url;
    if (nav.isError && !redirectedTo) {
      result.blocked.push({ kind: 'blocked', url: href, reason: firstLine(nav.text), as });
      return null;
    }
    if (landed && !checkUrl(landed, origins).allowed) {
      result.blocked.push({
        kind: 'blocked',
        url: landed,
        reason: `redirected outside allowedOrigins from ${href}`,
        as,
      });
      return null;
    }
    const snap = parseSnapshot((await call('browser_snapshot', {}, landed ?? href)).text);
    const url = snap.url ?? landed ?? href;
    visited.add(`${as} ${url}`);
    // Redirects (e.g. to /login) land on pages already recorded for this identity: keep one record.
    if (result.pages.some((p) => p.as === as && p.url === url)) return snap.elements;
    const page: PageObservation = {
      id: `obs-${String(++counter).padStart(3, '0')}`,
      kind: 'page',
      provenance: 'observed',
      url,
      path: new URL(url).pathname,
      title: snap.title,
      as,
      observedAt: now().toISOString(),
      via: 'browser_snapshot',
      elements: snap.elements
        .filter((e) => !['main', 'navigation', 'form', 'table'].includes(e.role) || e.name)
        .map((e, i) => {
          const el: ObservedElement = {
            id: `${`obs-${String(counter).padStart(3, '0')}`}-e${i + 1}`,
            role: e.role,
            name: e.name,
            locator: suggestLocator(e),
          };
          if (e.level !== undefined) el.level = e.level;
          if (e.href !== undefined) el.href = e.href;
          if (e.text !== undefined) el.text = maskValues(e.text, secrets);
          return el;
        }),
    };
    result.pages.push(page);
    return snap.elements;
  };

  const crawl = async () => {
    while (queue.length && result.pages.length < maxPages) {
      const href = queue.shift() ?? '';
      if (visited.has(`${as} ${href}`)) continue;
      const elements = await visit(href);
      for (const e of elements ?? []) if (e.role === 'link' && e.href) enqueue(e.href);
    }
  };

  try {
    for (const s of [base.href, ...options.seeds]) enqueue(s);
    await crawl();

    const authRole = config.exploration.authRole;
    const recipe = config.exploration.auth;
    if (authRole && recipe) {
      if (!options.credentials) {
        result.auth = {
          role: authRole,
          status: 'skipped',
          detail: 'no credentials in the environment for this role',
        };
      } else if (result.pages.length < maxPages) {
        loginFlowActive = true;
        try {
          const elements = await visit(new URL(recipe.loginPath, base).href);
          const find = (role: string, name: string) =>
            elements?.find((e) => e.role === role && e.name === name && e.ref);
          const user = find('textbox', recipe.usernameLabel);
          const pass = find('textbox', recipe.passwordLabel);
          const submit = find('button', recipe.submitButton);
          if (!user?.ref || !pass?.ref || !submit?.ref) {
            result.auth = {
              role: authRole,
              status: 'failed',
              detail: 'login form elements not found on the login page',
            };
          } else {
            await call(
              'browser_fill_form',
              {
                fields: [
                  {
                    name: recipe.usernameLabel,
                    type: 'textbox',
                    target: user.ref,
                    value: options.credentials.username,
                  },
                  {
                    name: recipe.passwordLabel,
                    type: 'textbox',
                    target: pass.ref,
                    value: options.credentials.password,
                  },
                ],
              },
              recipe.loginPath,
            );
            const clicked = await call(
              'browser_click',
              { element: `${recipe.submitButton} button`, target: submit.ref },
              recipe.submitButton,
            );
            const landed = parseSnapshot(clicked.text).url;
            const stillOnLogin = !landed || new URL(landed).pathname === recipe.loginPath;
            result.auth = stillOnLogin
              ? {
                  role: authRole,
                  status: 'failed',
                  detail: 'still on the login page after submitting',
                }
              : {
                  role: authRole,
                  status: 'signed-in',
                  detail: `landed on ${new URL(landed).pathname}`,
                };
          }
        } finally {
          loginFlowActive = false;
        }
        if (result.auth?.status === 'signed-in') {
          as = authRole;
          for (const s of [base.href, ...options.seeds]) enqueue(s);
          await crawl();
        }
      }
    }
  } finally {
    await tools.close();
  }
  return result;
}

/** Target URL of a navigation that Playwright reports as interrupted by another navigation. */
export function redirectTarget(text: string): string | null {
  const target = /is interrupted by another navigation to "([^"]+)"/.exec(text)?.[1] ?? null;
  // Only a real http(s) target is a redirect; `chrome-error://…` / `about:` are leftovers of an
  // earlier failed navigation and are treated as transient errors (retried).
  return target && /^https?:\/\//.test(target) ? target : null;
}

/** The informative error line of an MCP error result (skips markdown headings like `### Error`). */
export function firstLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return (lines.find((l) => /error/i.test(l)) ?? lines[0] ?? 'unknown error').slice(0, 200);
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start the plugin's Playwright MCP server for one project: allowlist and output dir come from
 * the project, everything else (pinned version, headless, isolated) from the plugin's .mcp.json.
 */
export async function startPlaywrightTools(options: {
  pluginRoot: string;
  projectRoot: string;
  config: ProjectConfig;
}): Promise<BrowserTools & { client: McpClient }> {
  let cfg = readServerConfig(options.pluginRoot);
  cfg = {
    ...cfg,
    args: withFlag(cfg.args, '--allowed-origins', options.config.allowedOrigins.join(';')),
  };
  cfg = { ...cfg, args: withFlag(cfg.args, '--output-dir', 'qa-artifacts/playwright-mcp') };
  const client = await McpClient.start(cfg, {
    cwd: options.projectRoot,
    // Backstop only: per-call limits are enforced by explore() (launch allowance included).
    timeoutMs: Math.max(options.config.exploration.timeoutMs, LAUNCH_TIMEOUT_MS),
  });
  return {
    client,
    callTool: (name, args) => client.callTool(name, args),
    close: async () => {
      try {
        await client.callTool('browser_close', {});
      } catch {
        /* browser may already be closed */
      }
      await client.close();
    },
  };
}

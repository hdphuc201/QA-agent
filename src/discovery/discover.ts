// `discover` stage: config → safe source read → static map → (optional) live MCP exploration →
// `.qa-agent/discovery/{project-map,observations}.json` with provenance and cross-references.

import { z } from 'zod';
import type { ProjectConfig } from '../config/project-config.schema.ts';
import { writeProjectFile } from '../config/write-guard.ts';
import { resolveCredentials, type Env } from '../sessions/accounts.ts';
import {
  explore,
  type BrowserTools,
  type ExplorationResult,
  type PageObservation,
} from './explorer.ts';
import { buildStaticMap, type ProjectMap } from './project-map.ts';
import { readProjectSources, type ReadResult } from './source-reader.ts';

export const DISCOVERY_SCHEMA_VERSION = 1;
export const DISCOVERY_DIR = '.qa-agent/discovery';

const SourceRef = z.object({ file: z.string(), line: z.int().positive() });
const Item = z.object({
  id: z.string(),
  provenance: z.enum(['observed', 'source-derived', 'hypothesized']),
  confidence: z.number().min(0).max(1),
  sources: z.array(SourceRef),
  observedIn: z.array(z.string()),
});

/** Output contract (validated before writing). */
export const ProjectMapFileSchema = z.object({
  schemaVersion: z.literal(DISCOVERY_SCHEMA_VERSION),
  projectId: z.string(),
  generatedAt: z.string(),
  baseURL: z.string(),
  sources: z.object({
    read: z.array(
      z.object({
        path: z.string(),
        kind: z.enum(['doc', 'source']),
        size: z.int(),
        redactions: z.int(),
      }),
    ),
    skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  }),
  routes: z.array(Item.extend({ method: z.string(), path: z.string(), api: z.boolean() })),
  forms: z.array(
    Item.extend({
      action: z.string().nullable(),
      method: z.string(),
      fields: z.array(
        z.object({ label: z.string().nullable(), name: z.string().nullable(), type: z.string() }),
      ),
      submit: z.array(z.string()),
    }),
  ),
  ui: z.array(Item.extend({ role: z.string(), name: z.string(), href: z.string().optional() })),
  roles: z.array(Item.extend({ name: z.string(), configured: z.boolean() })),
  exploration: z.object({
    live: z.boolean(),
    pages: z.int(),
    auth: z.object({ role: z.string(), status: z.string(), detail: z.string() }).nullable(),
    blocked: z.array(z.object({ url: z.string(), reason: z.string(), as: z.string() })),
    toolCalls: z.int(),
    note: z.string(),
  }),
});
export type ProjectMapFile = z.infer<typeof ProjectMapFileSchema>;

export interface DiscoverOptions {
  projectRoot: string;
  config: ProjectConfig;
  env?: Env;
  /** Live exploration tools (Playwright MCP); omit for a static-only run. */
  tools?: BrowserTools | null;
  now?: () => Date;
}

export interface DiscoverResult {
  map: ProjectMapFile;
  observations: {
    schemaVersion: number;
    projectId: string;
    generatedAt: string;
    pages: PageObservation[];
  };
  files: { projectMap: string; observations: string };
}

const pathPattern = (p: string) =>
  new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:param/g, '[^/]+')}$`);
const id = (prefix: string, i: number) => `${prefix}-${String(i + 1).padStart(3, '0')}`;

/** Merge static map and observations; adds `observedIn` links and observed-only routes. */
export function mergeDiscovery(
  config: ProjectConfig,
  read: ReadResult,
  map: ProjectMap,
  exploration: ExplorationResult | null,
  generatedAt: string,
): ProjectMapFile {
  const pages = exploration?.pages ?? [];
  const elements = pages.flatMap((p) => p.elements.map((e) => ({ page: p, e })));

  const routes: ProjectMapFile['routes'] = map.routes.map((r, i) => ({
    id: id('route', i),
    ...r,
    observedIn:
      r.method === 'GET' || r.method === 'ANY'
        ? pages.filter((p) => pathPattern(r.path).test(p.path)).map((p) => p.id)
        : [],
  }));
  for (const p of pages) {
    if (
      !routes.some(
        (r) => (r.method === 'GET' || r.method === 'ANY') && pathPattern(r.path).test(p.path),
      )
    ) {
      const existing = routes.find((r) => r.provenance === 'observed' && r.path === p.path);
      if (existing) existing.observedIn.push(p.id);
      else
        routes.push({
          id: id('route', routes.length),
          method: 'GET',
          path: p.path,
          api: false,
          provenance: 'observed',
          confidence: 1,
          sources: [],
          observedIn: [p.id],
        });
    }
  }
  const ui: ProjectMapFile['ui'] = map.ui.map((u, i) => ({
    id: id('ui', i),
    ...u,
    observedIn: elements
      .filter(({ e }) => e.role === u.role && e.name === u.name)
      .map(({ e }) => e.id),
  }));
  const forms: ProjectMapFile['forms'] = map.forms.map((f, i) => ({
    id: id('form', i),
    ...f,
    observedIn: pages
      .filter((p) =>
        f.submit.every((s) => p.elements.some((e) => e.role === 'button' && e.name === s)),
      )
      .filter((p) =>
        f.fields.every((fl) => !fl.label || p.elements.some((e) => e.name === fl.label)),
      )
      .map((p) => p.id),
  }));
  const configured = config.roles.map((r) => r.name);
  const roles: ProjectMapFile['roles'] = map.roles.map((r, i) => ({
    id: id('role', i),
    ...r,
    configured: configured.includes(r.name),
    observedIn: pages.filter((p) => p.as === r.name).map((p) => p.id),
  }));
  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    projectId: config.projectId,
    generatedAt,
    baseURL: config.baseURL,
    sources: {
      read: read.files.map(({ path, kind, size, redactions }) => ({
        path,
        kind,
        size,
        redactions,
      })),
      skipped: read.skipped,
    },
    routes,
    forms,
    ui,
    roles,
    exploration: {
      live: exploration !== null,
      pages: pages.length,
      auth: exploration?.auth ?? null,
      blocked: (exploration?.blocked ?? []).map(({ url, reason, as }) => ({ url, reason, as })),
      toolCalls: exploration?.toolCalls.length ?? 0,
      note: 'Observed behaviour is not required behaviour: expected results come from requirements only (roadmap §7.2).',
    },
  };
}

export async function runDiscover(options: DiscoverOptions): Promise<DiscoverResult> {
  const { projectRoot, config } = options;
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const read = readProjectSources(projectRoot, {
    docsPaths: config.docsPaths,
    sourcePaths: config.sourcePaths,
  });
  const map = buildStaticMap(
    read.files,
    config.roles.map((r) => r.name),
  );
  let exploration: ExplorationResult | null = null;
  if (options.tools) {
    const authRole = config.exploration.authRole;
    const account = config.roles.find((r) => r.name === authRole)?.accountKey;
    const seeds = map.routes
      .filter((r) => r.method === 'GET' && !r.api && !r.path.includes(':'))
      .map((r) => r.path);
    exploration = await explore({
      config,
      seeds,
      credentials: account ? resolveCredentials(account, options.env ?? process.env) : null,
      tools: options.tools,
      ...(options.now ? { now: options.now } : {}),
    });
  }
  const projectMap = ProjectMapFileSchema.parse(
    mergeDiscovery(config, read, map, exploration, generatedAt),
  );
  const observations = {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    projectId: config.projectId,
    generatedAt,
    pages: exploration?.pages ?? [],
  };
  const files = {
    projectMap: writeProjectFile(
      projectRoot,
      config,
      `${DISCOVERY_DIR}/project-map.json`,
      `${JSON.stringify(projectMap, null, 2)}\n`,
    ),
    observations: writeProjectFile(
      projectRoot,
      config,
      `${DISCOVERY_DIR}/observations.json`,
      `${JSON.stringify(observations, null, 2)}\n`,
    ),
  };
  return { map: projectMap, observations, files };
}

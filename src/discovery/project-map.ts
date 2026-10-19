// Static (source/docs-derived) project map: routes, forms, interactive UI, role hints, API refs.
// Every item carries where it came from and how confident the extraction is. Nothing here is an
// expected behaviour; it is a map of what exists, for exploration and planning.

import type { ReadFile } from './source-reader.ts';

export type Provenance = 'observed' | 'source-derived' | 'hypothesized';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ANY';

export interface SourceRef {
  file: string;
  line: number;
}

export interface MapItemBase {
  provenance: Provenance;
  confidence: number; // 0..1
  sources: SourceRef[];
}

export interface RouteItem extends MapItemBase {
  method: HttpMethod;
  path: string; // `:param` for dynamic segments
  api: boolean;
}

export interface FormField {
  label: string | null;
  name: string | null;
  type: string;
}

export interface FormItem extends MapItemBase {
  action: string | null;
  method: string;
  fields: FormField[];
  submit: string[];
}

export interface UiItem extends MapItemBase {
  role: 'button' | 'link';
  name: string;
  href?: string;
}

export interface RoleHint extends MapItemBase {
  name: string;
}

export interface ProjectMap {
  routes: RouteItem[];
  forms: FormItem[];
  ui: UiItem[];
  roles: RoleHint[];
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/**
 * Regex route source → concrete paths. Word alternations expand, other groups become `:param`:
 * `^\/requests\/(REQ-\d+)\/(approve|reject)$` → `/requests/:param/approve`, `/requests/:param/reject`.
 */
export function regexRouteToPaths(source: string): string[] {
  if (!source.startsWith('^\\/')) return [];
  let variants = [source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/')];
  for (;;) {
    const group = /\((?!\?)([^()]*)\)/.exec(variants[0] ?? '');
    if (!group) break;
    const alts = /^[a-z][\w-]*(\|[a-z][\w-]*)+$/i.test(group[1] ?? '')
      ? (group[1] ?? '').split('|')
      : [':param'];
    variants = variants.flatMap((v) => alts.map((a) => v.replace(group[0], a)));
  }
  return variants.every((v) => /^\/[\w\-/:.]*$/.test(v)) ? variants : [];
}

/** Collapse whitespace and strip tags/template expressions from visible text. */
const visibleText = (html: string) =>
  html
    .replace(/\$\{[^}]*\}/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function mergeInto<T extends MapItemBase>(list: T[], item: T, key: (x: T) => string) {
  const existing = list.find((x) => key(x) === key(item));
  if (!existing) {
    list.push(item);
    return;
  }
  for (const s of item.sources) {
    if (!existing.sources.some((e) => e.file === s.file && e.line === s.line))
      existing.sources.push(s);
  }
  existing.confidence = Math.max(existing.confidence, item.confidence);
}

function extractRoutes(file: ReadFile, out: RouteItem[]) {
  const text = file.content;
  const add = (
    method: HttpMethod,
    rawPath: string,
    index: number,
    confidence: number,
    provenance: Provenance = 'source-derived',
  ) => {
    // One canonical name for dynamic segments so docs (`<id>`) and code (`:id`, regex groups) merge.
    const path = rawPath.replace(/:\w+/g, ':param');
    mergeInto(
      out,
      {
        method,
        path,
        api: path.startsWith('/api/'),
        provenance,
        confidence,
        sources: [{ file: file.path, line: lineOf(text, index) }],
      },
      (r) => `${r.method} ${r.path}`,
    );
  };

  if (file.kind === 'source') {
    // Express / Koa / Fastify style: app.get('/x', ...)
    for (const m of text.matchAll(
      /\b(?:app|router|server|fastify)\.(get|post|put|patch|delete)\(\s*['"`](\/[^'"`\s]*)['"`]/gi,
    )) {
      add(
        (m[1] ?? 'GET').toUpperCase() as HttpMethod,
        (m[2] ?? '/').replace(/\{(\w+)\}/g, ':$1'),
        m.index,
        0.9,
      );
    }
    // Plain node:http: `m === 'POST' && p === '/login'`
    for (const m of text.matchAll(
      /(?:\b(?:method|m)\s*===\s*['"](GET|POST|PUT|PATCH|DELETE)['"]\s*&&\s*)?\b(?:pathname|path|p|url)\s*===\s*['"](\/[^'"\s]*)['"]/g,
    )) {
      add((m[1] as HttpMethod | undefined) ?? 'ANY', m[2] ?? '/', m.index, m[1] ? 0.8 : 0.6);
    }
    // Regex routes: /^\/requests\/(REQ-\d+)$/.exec(p)
    for (const m of text.matchAll(
      /\/(\^\\\/[^/\n]*(?:\\\/[^/\n]*)*)\/[gimsuy]*\.(?:exec|test)\(/g,
    )) {
      for (const path of regexRouteToPaths(m[1] ?? '')) add('ANY', path, m.index, 0.5);
    }
    // File-system routing (Next.js pages/ and app/ directories).
    const fsRoute = /(?:^|\/)(?:pages|app)\/(.+?)(?:\/page|\/index)?\.(?:tsx|jsx|ts|js)$/.exec(
      file.path,
    );
    if (fsRoute?.[1] && !/(^|\/)(_app|_document|layout|api\/.*)$/.test(fsRoute[1])) {
      const p =
        `/${fsRoute[1].replace(/^index$/, '').replace(/\[(?:\.\.\.)?(\w+)\]/g, ':$1')}`.replace(
          /\/$/,
          '',
        ) || '/';
      add('GET', p, 0, 0.7);
    }
  }
  // API references in prose: `GET /api/requests`, `POST /api/requests/<id>/approve`
  for (const m of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+`?(\/api\/[^\s`'")]*)/g)) {
    add(
      m[1] as HttpMethod,
      (m[2] ?? '').replace(/<(\w+)>/g, ':$1'),
      m.index,
      file.kind === 'doc' ? 0.6 : 0.7,
    );
  }
}

function extractForms(file: ReadFile, forms: FormItem[], ui: UiItem[]) {
  const text = file.content;
  for (const m of text.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const action = /\baction="([^"]*)"/.exec(attrs)?.[1]?.replace(/\$\{[^}]*\}/g, ':param') ?? null;
    const method = (/\bmethod="(\w+)"/i.exec(attrs)?.[1] ?? 'get').toUpperCase();
    const fields: FormField[] = [];
    for (const lm of body.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)) {
      const inner = lm[1] ?? '';
      const input = /<(input|select|textarea)\b([^>]*)>/i.exec(inner);
      if (!input) continue;
      const iattrs = input[2] ?? '';
      fields.push({
        label: visibleText(inner.slice(0, input.index)) || null,
        name: /\bname="([^"]+)"/.exec(iattrs)?.[1] ?? null,
        type:
          /\btype="([^"]+)"/.exec(iattrs)?.[1] ??
          (input[1] === 'input' ? 'text' : (input[1] ?? 'text')),
      });
    }
    const submit = [...body.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)]
      .map((b) => visibleText(b[1] ?? ''))
      .filter(Boolean);
    const item: FormItem = {
      action: action || null,
      method,
      fields,
      submit,
      provenance: 'source-derived',
      confidence: action ? 0.8 : 0.6,
      sources: [{ file: file.path, line: lineOf(text, m.index) }],
    };
    mergeInto(
      forms,
      item,
      (f) => `${f.method} ${f.action ?? ''} ${f.fields.map((x) => x.label).join('|')}`,
    );
  }
  for (const m of text.matchAll(/<a\b[^>]*\bhref="(\/[^"$]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const name = visibleText(m[2] ?? '');
    if (!name) continue;
    mergeInto(
      ui,
      {
        role: 'link',
        name,
        href: m[1] ?? '',
        provenance: 'source-derived',
        confidence: 0.7,
        sources: [{ file: file.path, line: lineOf(text, m.index) }],
      },
      (u) => `${u.role} ${u.name} ${u.href ?? ''}`,
    );
  }
  for (const m of text.matchAll(/<button\b[^>]*>([^<$]+)<\/button>/gi)) {
    const name = visibleText(m[1] ?? '');
    if (!name) continue;
    mergeInto(
      ui,
      {
        role: 'button',
        name,
        provenance: 'source-derived',
        confidence: 0.7,
        sources: [{ file: file.path, line: lineOf(text, m.index) }],
      },
      (u) => `${u.role} ${u.name}`,
    );
  }
}

function extractRoles(file: ReadFile, roles: RoleHint[], known: string[]) {
  const text = file.content;
  const add = (name: string, index: number, confidence: number, provenance: Provenance) =>
    mergeInto(
      roles,
      { name, provenance, confidence, sources: [{ file: file.path, line: lineOf(text, index) }] },
      (r) => r.name,
    );
  if (file.kind === 'doc') {
    // Markdown table rows under a roles section: `| requester | ...`
    for (const m of text.matchAll(/^\|\s*`?([a-z][a-z0-9_-]{1,31})`?\s*\|/gim)) {
      const name = (m[1] ?? '').toLowerCase();
      if (!['role', 'name', '---'].includes(name)) add(name, m.index, 0.8, 'source-derived');
    }
    for (const m of text.matchAll(/^- Actors?:\s*(.+)$/gim)) {
      for (const n of (m[1] ?? '').split(/[,;]\s*/)) {
        const name = n.trim().toLowerCase();
        if (/^[a-z][a-z0-9_-]{1,31}$/.test(name)) add(name, m.index, 0.7, 'source-derived');
      }
    }
  } else {
    // `role === 'approver'` / `role: 'requester'` in code: a hint, not a definition.
    for (const m of text.matchAll(/\brole\s*(?:===|==|:)\s*['"]([a-z][a-z0-9_-]{1,31})['"]/gi)) {
      const name = (m[1] ?? '').toLowerCase();
      add(
        name,
        m.index,
        known.includes(name) ? 0.7 : 0.4,
        known.includes(name) ? 'source-derived' : 'hypothesized',
      );
    }
  }
}

/** Build the static map from files returned by `readProjectSources`. */
export function buildStaticMap(files: ReadFile[], configuredRoles: string[] = []): ProjectMap {
  const map: ProjectMap = { routes: [], forms: [], ui: [], roles: [] };
  for (const f of files) {
    extractRoutes(f, map.routes);
    extractForms(f, map.forms, map.ui);
  }
  for (const f of [...files].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'doc' ? -1 : 1))) {
    extractRoles(f, map.roles, configuredRoles);
  }
  // A route that also appears with a concrete method makes its `ANY` twin redundant.
  map.routes = map.routes.filter((r) => {
    if (r.method !== 'ANY') return true;
    const concrete = map.routes.filter((o) => o.path === r.path && o.method !== 'ANY');
    for (const c of concrete) {
      for (const s of r.sources)
        if (!c.sources.some((e) => e.file === s.file && e.line === s.line)) c.sources.push(s);
      c.confidence = Math.max(c.confidence, r.confidence);
    }
    return concrete.length === 0;
  });
  map.routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  map.roles.sort((a, b) => a.name.localeCompare(b.name));
  return map;
}

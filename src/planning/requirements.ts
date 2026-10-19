// Requirements mapper: parses requirement documents (controlled format, docs/REQUIREMENTS_FORMAT.md)
// and links each requirement to the project-map items it mentions. Expected results come only
// from `Expected` lines; code and observations never create expectations.

import type { ProjectMapFile } from '../discovery/discover.ts';
import type { ReadFile } from '../discovery/source-reader.ts';
import { PLAN_SCHEMA_VERSION, type PriorityT, type Requirement } from './schema.ts';

const HEADING = /^#{2,4}\s+([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s+[—–-]\s+(.+?)\s*$/;
const FIELD = /^\s*[-*]\s+([A-Za-z]+)(?:\s*\(([^)]+)\))?\s*:\s*(.+?)\s*$/;

/** Split "requester, approver" / "a requester or viewer" into role names. */
export function splitActors(text: string): string[] {
  return text
    .split(/,|\bor\b|\band\b/i)
    .map((s) =>
      s
        .trim()
        .replace(/^(an?|the)\s+/i, '')
        .toLowerCase(),
    )
    .filter((s) => /^[a-z][a-z0-9_-]*$/.test(s));
}

export function parseRequirementsDoc(file: Pick<ReadFile, 'path' | 'content'>): Requirement[] {
  const out: Requirement[] = [];
  let current: Requirement | null = null;
  const lines = file.content.split(/\r?\n/);
  lines.forEach((line, i) => {
    const h = HEADING.exec(line);
    if (h?.[1] && h[2]) {
      current = {
        schemaVersion: PLAN_SCHEMA_VERSION,
        id: h[1],
        title: h[2],
        feature: null,
        priority: 'P2',
        actors: [],
        given: [],
        when: [],
        expected: [],
        rules: [],
        boundaries: [],
        notes: [],
        source: { file: file.path, line: i + 1 },
        mapRefs: [],
      };
      out.push(current);
      return;
    }
    if (/^#{1,4}\s/.test(line)) {
      current = null; // a non-requirement heading ends the block
      return;
    }
    const f = FIELD.exec(line);
    const req = current as Requirement | null;
    if (!f || !req) return;
    const key = (f[1] ?? '').toLowerCase();
    const label = f[2]?.trim().toLowerCase() ?? null;
    const value = f[3] ?? '';
    switch (key) {
      case 'feature':
        req.feature = value;
        break;
      case 'priority':
        if (/^P[012]$/.test(value)) req.priority = value as PriorityT;
        else req.notes.push(`invalid priority "${value}" (defaulted to P2)`);
        break;
      case 'actor':
      case 'actors':
        req.actors.push(...splitActors(value));
        break;
      case 'given':
        req.given.push(value);
        break;
      case 'when':
        req.when.push(value);
        break;
      case 'expected':
        req.expected.push({ text: value, label, source: { file: file.path, line: i + 1 } });
        break;
      case 'rule':
        req.rules.push(value);
        break;
      case 'boundary': {
        const m = /^([a-z][\w ]*?)\s+((?:-?\d+(?:\.\d+)?\s*(?:,|and)?\s*)+)(?:are\s+\w+)?$/i.exec(
          value,
        );
        if (m?.[1] && m[2]) {
          req.boundaries.push({
            label: label ?? 'boundary',
            field: m[1].trim().toLowerCase(),
            values: m[2]
              .split(/\s*(?:,|and)\s*/)
              .map((v) => v.trim())
              .filter(Boolean),
          });
        } else req.notes.push(`unparsed boundary "${value}"`);
        break;
      }
      default:
        req.notes.push(`${f[1]}: ${value}`);
    }
  });
  return out;
}

/** Attach project-map item IDs mentioned by a requirement (backticked paths, quoted UI names). */
export function linkRequirements(reqs: Requirement[], map: ProjectMapFile | null): Requirement[] {
  if (!map) return reqs;
  return reqs.map((r) => {
    const text = [...r.given, ...r.when, ...r.expected.map((e) => e.text)].join('\n');
    const refs = new Set<string>();
    for (const m of text.matchAll(/`(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(\/[^`\s]*)`/g)) {
      const path = (m[2] ?? '').replace(/<\w+>/g, ':param');
      for (const route of map.routes) {
        if (route.path === path && (!m[1] || route.method === m[1] || route.method === 'ANY'))
          refs.add(route.id);
      }
    }
    for (const m of text.matchAll(/"([^"]+)"/g)) {
      for (const u of map.ui) if (u.name === m[1]) refs.add(u.id);
    }
    return { ...r, mapRefs: [...refs].sort() };
  });
}

/** Routes in the project map that no requirement mentions (coverage gaps, never test cases). */
export function unreferencedRoutes(reqs: Requirement[], map: ProjectMapFile | null): string[] {
  if (!map) return [];
  const used = new Set(reqs.flatMap((r) => r.mapRefs));
  return map.routes.filter((r) => !used.has(r.id)).map((r) => `${r.method} ${r.path}`);
}

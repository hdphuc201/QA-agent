// Parser for Playwright MCP tool output (`### Page` header + ARIA snapshot YAML).

export interface SnapshotElement {
  role: string;
  name: string | null;
  ref: string | null;
  level?: number;
  href?: string;
  text?: string;
  depth: number;
}

export interface ParsedSnapshot {
  url: string | null;
  title: string | null;
  elements: SnapshotElement[];
}

export const INTERESTING_ROLES = new Set([
  'heading',
  'link',
  'button',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'spinbutton',
  'switch',
  'slider',
  'alert',
  'navigation',
  'main',
  'form',
  'table',
  'dialog',
  'columnheader',
  'cell',
  'term',
  'definition',
  'status',
]);

const LINE = /^(\s*)- (\/?[\w-]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]+\])*)(?::\s*(.*))?$/;

/** Parse the page URL/title header and the YAML snapshot body. */
export function parseSnapshot(text: string): ParsedSnapshot {
  const url = /^- Page URL: (.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const title = /^- Page Title: (.*)$/m.exec(text)?.[1]?.trim() ?? null;
  const yaml = /```yaml\n([\s\S]*?)```/.exec(text)?.[1] ?? '';
  const elements: SnapshotElement[] = [];
  const stack: { depth: number; el: SnapshotElement | null }[] = [];
  for (const line of yaml.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const depth = (m[1] ?? '').length / 2;
    const role = m[2] ?? '';
    while (stack.length && (stack.at(-1)?.depth ?? 0) >= depth) stack.pop();
    const parent = stack.at(-1)?.el ?? null;
    if (role === '/url') {
      if (parent && parent.role === 'link') parent.href = (m[5] ?? '').trim();
      continue;
    }
    const attrs = m[4] ?? '';
    const name = m[3] !== undefined ? m[3].replace(/\\"/g, '"') : null;
    const el: SnapshotElement = {
      role,
      name,
      ref: /\[ref=([\w-]+)\]/.exec(attrs)?.[1] ?? null,
      depth,
    };
    const level = /\[level=(\d+)\]/.exec(attrs)?.[1];
    if (level) el.level = Number(level);
    const value = (m[5] ?? '').trim().replace(/^"(.*)"$/, '$1');
    if (value) el.text = value;
    stack.push({ depth, el });
    if (INTERESTING_ROLES.has(role)) elements.push(el);
  }
  return { url, title, elements };
}

/** A Playwright locator expression for an observed element (role + accessible name). */
export function suggestLocator(el: Pick<SnapshotElement, 'role' | 'name'>): string {
  const roleArg = JSON.stringify(el.role).replace(/"/g, "'");
  return el.name
    ? `getByRole(${roleArg}, { name: ${JSON.stringify(el.name)} })`
    : `getByRole(${roleArg})`;
}

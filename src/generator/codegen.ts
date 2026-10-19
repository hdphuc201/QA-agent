// TestCase (READY) → Playwright test source. Locators: getByRole / getByLabel with exact names
// (no CSS). Assertions mirror the case's structured assertions one to one; nothing is added,
// relaxed or dropped here.

import { analyzeIsolation } from '../orchestrator/isolation.ts';
import type { Assertion, Step, TestCase, ValueT } from '../planning/schema.ts';

export class GenerationError extends Error {
  override name = 'GenerationError';
}

/** Single-quoted TS string literal. */
export function q(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
}

/** Role (+ extra tab) → safe identifier: `requesterPage`, `requesterTab2`. */
export const pageVar = (role: string, tab?: number) =>
  `${role.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))}${tab ? `Tab${tab}` : 'Page'}`;

/** Path expression: literal, or a template using the captured subject. */
export function pathExpr(path: string): string {
  if (path === '{{subject.path}}') return 'subject.path';
  if (!path.includes('{{')) return q(path);
  const body = path
    .replace(/`/g, '\\`')
    .replace(/\{\{subject\.(path|id)\}\}/g, (_, k: string) => `\${subject.${k}}`);
  if (/\{\{/.test(body)) throw new GenerationError(`unsupported placeholder in ${path}`);
  return `\`${body}\``;
}

function valueExpr(v: ValueT): string {
  if ('literal' in v) return q(v.literal);
  if ('unique' in v) return `data.${v.unique}`;
  if (v.ref.startsWith('data.')) return v.ref;
  throw new GenerationError(`unresolved value reference ${v.ref}`);
}

function stepCode(s: Step): string[] {
  const p = pageVar(s.as, 'tab' in s ? s.tab : undefined);
  switch (s.do) {
    case 'login':
      return [
        s.invalidPassword
          ? `await actors.login(${q(s.as)}, { invalidPassword: true });`
          : `await actors.login(${q(s.as)});`,
      ];
    case 'goto':
      return [`await ${p}.goto(${pathExpr(s.path)});`];
    case 'fill':
      return [`await ${p}.getByLabel(${q(s.label)}, { exact: true }).fill(${valueExpr(s.value)});`];
    case 'click':
      return [
        `await ${p}.getByRole(${q(s.role)}, { name: ${q(s.name)}, exact: true }).click();`,
        `await ${p}.waitForLoadState();`,
        ...(s.capture === 'subject' ? [`subject = subjectOf(${p});`] : []),
      ];
    case 'manual':
      throw new GenerationError(`manual step cannot be generated: ${s.text}`);
  }
}

function assertCode(a: Assertion, anchor: string | null, counts: Map<string, string>): string[] {
  const p = pageVar(a.as, 'tab' in a ? a.tab : undefined);
  switch (a.kind) {
    case 'url':
      return [`await expectPath(${p}, ${q(a.path)});`];
    case 'heading':
      return [
        `await expect(${p}.getByRole('heading', { name: ${q(a.name)}, exact: true })).toBeVisible();`,
      ];
    case 'text': {
      const value = valueExpr(a.value);
      if (anchor && 'literal' in a.value)
        return [`await expectTextNear(${p}, ${anchor}, ${value});`];
      return [`await expect(${p}.getByText(${value}, { exact: true }).first()).toBeVisible();`];
    }
    case 'alert':
      return [
        `await expect(${p}.getByRole('alert').filter({ hasText: ${q(a.text)} })).toBeVisible();`,
      ];
    case 'absent':
      return [
        `await expect(${p}.getByRole(${q(a.role)}, { name: ${q(a.name)}, exact: true })).toHaveCount(0);`,
      ];
    case 'apiStatus': {
      const body = a.body
        ? `{ ${Object.entries(a.body)
            .map(([k, v]) => `${q(k)}: ${q(v)}`)
            .join(', ')} }`
        : null;
      const opts = [`method: ${q(a.method)}`, ...(body ? [`data: ${body}`] : [])];
      return [
        `{`,
        `const res = await (await actors.request(${q(a.as)})).fetch(${pathExpr(a.path)}, { ${opts.join(', ')} });`,
        // The message shows the concrete path (subject id resolved), e.g. "POST /api/requests/REQ-7/approve".
        `expect(res.status(), ${q(`${a.method} `)} + ${pathExpr(a.path)} + ${q(` as ${a.as}`)}).toBe(${a.status});`,
        `}`,
      ];
    }
    case 'apiCountUnchanged': {
      const v = counts.get(`${a.as} ${a.path}`);
      if (!v) throw new GenerationError(`no baseline count for ${a.path}`);
      return [
        `expect(await apiCount(await actors.request(${q(a.as)}), ${q(a.path)}), ${q(`GET ${a.path} item count`)}).toBe(${v});`,
      ];
    }
    case 'manual':
      throw new GenerationError(`manual check cannot be generated: ${a.text}`);
  }
}

const roles = (c: TestCase) => {
  const seen: string[] = [];
  const add = (r: string) => {
    if (!seen.includes(r)) seen.push(r);
  };
  for (const s of [...c.setup, ...c.steps]) add(s.as);
  for (const e of c.expectations) {
    for (const s of e.before) add(s.as);
    for (const a of e.asserts) add(a.as);
  }
  return seen;
};

/** Source of one `test(...)` block for a READY case. */
export function caseToTest(c: TestCase): string {
  if (c.status !== 'READY')
    throw new GenerationError(`${c.id} is ${c.status}; only READY cases are generated`);
  const usesPage = (r: string) =>
    [...c.setup, ...c.steps, ...c.expectations.flatMap((e) => e.before)].some(
      (s) => s.as === r && s.do !== 'login',
    ) ||
    c.expectations.some((e) =>
      e.asserts.some((a) => a.as === r && !['apiStatus', 'apiCountUnchanged'].includes(a.kind)),
    );
  const lines: string[] = [];
  const serial = analyzeIsolation(c).isolation === 'serial';
  const tags = [
    `@${c.priority}`,
    `@${c.category}`,
    ...(serial ? ['@serial'] : []),
    ...c.requirementRefs.map((r) => `@${r}`),
  ];
  const annotations = [
    `{ type: 'qa-case', description: ${q(c.id)} }`,
    ...c.requirementRefs.map((r) => `{ type: 'requirement', description: ${q(r)} }`),
  ];
  lines.push(
    `test(${q(`${c.id} ${c.title}`)}, { tag: [${tags.map(q).join(', ')}], annotation: [${annotations.join(', ')}] }, async ({ actors }) => {`,
  );
  if (Object.keys(c.data).length) {
    lines.push(
      `const data = { ${Object.keys(c.data)
        .map((k) => `${k}: unique(${q(c.id)}, ${q(k)})`)
        .join(', ')} };`,
    );
  }
  const all = JSON.stringify([c.setup, c.steps, c.expectations]);
  if (all.includes('subject')) lines.push(`let subject: Subject = { path: '', id: '' };`);
  for (const r of roles(c))
    if (usesPage(r)) {
      // A role whose sign-in is under test (explicit login, valid or not) never reuses a cached session.
      const fresh = c.steps.some((s) => s.do === 'login' && s.as === r && !s.implicit);
      lines.push(
        `const ${pageVar(r)} = await actors.page(${q(r)}${fresh ? ', { fresh: true }' : ''});`,
      );
    }
  // Extra tabs of a role share its session (same context).
  const tabs = new Set<string>();
  for (const x of [
    ...c.setup,
    ...c.steps,
    ...c.expectations.flatMap((e) => [...e.before, ...e.asserts]),
  ]) {
    if ('tab' in x && x.tab) tabs.add(JSON.stringify([x.as, x.tab]));
  }
  for (const key of [...tabs].sort()) {
    const [role, tab] = JSON.parse(key) as [string, number];
    lines.push(`const ${pageVar(role, tab)} = await actors.newTab(${q(role)});`);
  }

  // Baselines for "no X is created": taken after sign-in, before the case's actions.
  const counts = new Map<string, string>();
  const baselines: string[] = [];
  for (const e of c.expectations) {
    for (const a of e.asserts) {
      if (a.kind !== 'apiCountUnchanged' || counts.has(`${a.as} ${a.path}`)) continue;
      const v = `countBefore${counts.size + 1}`;
      counts.set(`${a.as} ${a.path}`, v);
      // Declared at test scope: assigned in the steps block, read in an expectation block.
      lines.push(`let ${v} = 0;`);
      baselines.push(`${v} = await apiCount(await actors.request(${q(a.as)}), ${q(a.path)});`);
    }
  }

  if (c.setup.length) {
    lines.push(
      `await test.step(${q(`setup (from ${c.dependencies.join(', ') || 'case'})`)}, async () => {`,
      ...c.setup.flatMap(stepCode),
      `});`,
    );
  }
  const firstAction = c.steps.findIndex((s) => s.do !== 'login');
  const logins = firstAction === -1 ? c.steps : c.steps.slice(0, firstAction);
  const actions = firstAction === -1 ? [] : c.steps.slice(firstAction);
  if (logins.length || actions.length || baselines.length) {
    lines.push(
      `await test.step('steps', async () => {`,
      ...logins.flatMap(stepCode),
      ...baselines,
      ...actions.flatMap(stepCode),
      `});`,
    );
  }
  for (const e of c.expectations) {
    const refText = e.asserts.find((a) => a.kind === 'text' && 'ref' in a.value);
    const anchor = refText && refText.kind === 'text' ? valueExpr(refText.value) : null;
    lines.push(
      `await test.step(${q(`expect: ${e.text} (${e.source.file}:${e.source.line})`)}, async () => {`,
      ...e.before.flatMap(stepCode),
      ...e.asserts.flatMap((a) => assertCode(a, anchor, counts)),
      `});`,
    );
  }
  lines.push(`});`);
  return lines.join('\n');
}

/** `Feature name` → `feature-name.spec.ts` (deterministic). */
export function specFileName(feature: string | null): string {
  const slug =
    (feature ?? 'general')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'general';
  return `${slug}.spec.ts`;
}

export function specSource(feature: string | null, cases: TestCase[], planHash: string): string {
  const sorted = [...cases].sort((a, b) => a.id.localeCompare(b.id));
  const helpers = [
    'test',
    'expect',
    'expectPath',
    'expectTextNear',
    'apiCount',
    'unique',
    'subjectOf',
    'type Subject',
  ];
  return [
    `// GENERATED by QA Agent from .qa-agent/plan/test-plan.json (plan ${planHash}) — do not edit.`,
    `// Feature: ${feature ?? 'general'} · cases: ${sorted.map((c) => c.id).join(', ')}`,
    `// Expected results quote requirement lines; regenerate with \`qa-agent generate\` after the plan changes.`,
    `/* eslint-disable */`,
    `import { ${helpers.join(', ')} } from './qa-agent.fixtures';`,
    ``,
    `test.describe(${q(feature ?? 'general')}, () => {`,
    sorted.map(caseToTest).join('\n\n'),
    `});`,
    ``,
  ].join('\n');
}

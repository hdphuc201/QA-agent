// Test plan exports: versioned JSON (machine), Markdown (review), CSV (spreadsheets).

import type { Assertion, Step, TestPlan, ValueT } from './schema.ts';

const v = (x: ValueT) =>
  'literal' in x
    ? JSON.stringify(x.literal)
    : 'unique' in x
      ? `<unique ${x.unique}>`
      : `<${x.ref}>`;

export function describeStep(s: Step): string {
  switch (s.do) {
    case 'login':
      return `[${s.as}] sign in${s.invalidPassword ? ' with a wrong password' : ''}`;
    case 'goto':
      return `[${s.as}] open ${s.path}`;
    case 'fill':
      return `[${s.as}] fill "${s.label}" with ${v(s.value)}`;
    case 'click':
      return `[${s.as}] click ${s.role} "${s.name}"${s.capture ? ` (remember page as ${s.capture})` : ''}`;
    case 'manual':
      return `[${s.as}] MANUAL: ${s.text}`;
  }
}

export function describeAssertion(a: Assertion): string {
  switch (a.kind) {
    case 'url':
      return `[${a.as}] URL path is ${a.path}`;
    case 'heading':
      return `[${a.as}] heading "${a.name}" is visible`;
    case 'text':
      return `[${a.as}] text ${v(a.value)} is visible`;
    case 'alert':
      return `[${a.as}] alert "${a.text}" is visible`;
    case 'absent':
      return `[${a.as}] no ${a.role} "${a.name}"`;
    case 'apiStatus':
      return `[${a.as}] ${a.method} ${a.path}${a.body ? ` ${JSON.stringify(a.body)}` : ''} → HTTP ${a.status}`;
    case 'apiCountUnchanged':
      return `[${a.as}] GET ${a.path} returns as many items as before`;
    case 'manual':
      return `[${a.as}] MANUAL: ${a.text}`;
  }
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function planToMarkdown(plan: TestPlan): string {
  const ready = plan.cases.filter((c) => c.status === 'READY').length;
  const lines = [
    `# Test plan — ${plan.projectId}`,
    '',
    `- Generated: ${plan.generatedAt} (schemaVersion ${plan.schemaVersion})`,
    `- Requirements: ${plan.coverage.requirements}, with READY cases: ${plan.coverage.withReadyCases}`,
    `- Cases: ${plan.cases.length} (READY ${ready}, not runnable ${plan.cases.length - ready})`,
    `- Categories not required by any requirement: ${plan.coverage.categoriesNotRequired.join(', ') || '—'}`,
    `- Duplicates merged: ${plan.duplicatesMerged.map((d) => `${d.merged} → ${d.kept}`).join(', ') || '—'}`,
    '',
    'Expected results quote requirement lines only; observed UI behaviour is never used as an expected result.',
    '',
    '| Case | Status | Category | Priority | Risk | Requirements | Title |',
    '|---|---|---|---|---|---|---|',
    ...plan.cases.map(
      (c) =>
        `| ${c.id} | ${c.status} | ${c.category} | ${c.priority} | ${c.riskScore} | ${c.requirementRefs.join(', ')} | ${cell(c.title)} |`,
    ),
    '',
  ];
  const notRunnable = plan.cases.filter((c) => c.status !== 'READY');
  if (notRunnable.length) {
    lines.push('## Needs review / blocked', '');
    for (const c of notRunnable)
      lines.push(
        `- **${c.id}** (${c.status}): ${c.blockers.join('; ') || 'contains manual steps or checks'}`,
      );
    lines.push('');
  }
  lines.push('## Cases', '');
  for (const c of plan.cases) {
    lines.push(
      `### ${c.id} — ${c.title}`,
      '',
      `- Status: ${c.status} · ${c.category} · ${c.priority} (risk ${c.riskScore})`,
    );
    lines.push(
      `- Requirements: ${c.requirementRefs.join(', ')}; depends on: ${c.dependencies.join(', ') || '—'}`,
    );
    lines.push(
      `- Actors: ${c.actors.map((a) => `${a.role}${a.accountKey ? ` (${a.accountKey})` : ''}`).join(', ')}`,
    );
    if (c.setup.length) lines.push('- Setup:', ...c.setup.map((s) => `  - ${describeStep(s)}`));
    if (c.steps.length) lines.push('- Steps:', ...c.steps.map((s) => `  - ${describeStep(s)}`));
    lines.push('- Expected:');
    if (!c.expectations.length) lines.push('  - (none defined in the requirement)');
    for (const e of c.expectations) {
      lines.push(`  - "${e.text}" — ${e.source.file}:${e.source.line}`);
      for (const s of e.before) lines.push(`    - then ${describeStep(s)}`);
      for (const a of e.asserts) lines.push(`    - check ${describeAssertion(a)}`);
    }
    lines.push('');
  }
  if (plan.coverage.unreferencedRoutes.length) {
    lines.push(
      '## Routes not referenced by any requirement (no cases generated)',
      '',
      ...plan.coverage.unreferencedRoutes.map((r) => `- ${r}`),
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const csv = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function planToCsv(plan: TestPlan): string {
  const header = [
    'id',
    'status',
    'category',
    'priority',
    'riskScore',
    'title',
    'requirementRefs',
    'dependencies',
    'blockers',
  ];
  const rows = plan.cases.map((c) =>
    [
      c.id,
      c.status,
      c.category,
      c.priority,
      String(c.riskScore),
      c.title,
      c.requirementRefs.join(' '),
      c.dependencies.join(' '),
      c.blockers.join('; '),
    ]
      .map(csv)
      .join(','),
  );
  return `${[header.join(','), ...rows].join('\n')}\n`;
}

// Test planner: requirements (+ project map for HOW) → deduplicated, risk-ranked test matrix with
// dependencies and honest statuses. A case is READY only when every expected result comes from a
// requirement sentence and is machine-checkable; otherwise NEEDS_REVIEW or BLOCKED.

import { destructiveReason } from '../config/policy.ts';
import type { ProjectConfig } from '../config/project-config.schema.ts';
import type { ProjectMapFile } from '../discovery/discover.ts';
import {
  interpretExpected,
  interpretGiven,
  interpretWhen,
  RECORD_REF,
  sentenceActors,
  type InterpretContext,
} from './interpret.ts';
import { unreferencedRoutes } from './requirements.ts';
import {
  Category,
  PLAN_SCHEMA_VERSION,
  TestPlanSchema,
  type Assertion,
  type CategoryT,
  type Expectation,
  type PriorityT,
  type Requirement,
  type Step,
  type TestCase,
  type TestPlan,
} from './schema.ts';

export interface PlanInput {
  config: ProjectConfig;
  requirements: Requirement[];
  map: ProjectMapFile | null;
  generatedAt: string;
  requirementsFiles: string[];
  projectMapPath: string | null;
}

interface Draft {
  req: Requirement;
  suffix: string;
  actor: string;
  categoryHint: CategoryT | null;
  steps: Step[];
  expectations: Expectation[];
  needsSubject: { status: string; creator: string | null } | null;
  blockers: string[];
  setup: Step[];
  dependencies: string[];
  data: Record<string, string>;
  id: string;
  dropped?: boolean;
}

const IMPACT: Record<PriorityT, number> = { P0: 1, P1: 0.6, P2: 0.3 };
const LIKELIHOOD: Record<CategoryT, number> = {
  rbac: 1,
  'state-transition': 0.9,
  concurrency: 0.9,
  negative: 0.8,
  boundary: 0.8,
  'network-failure': 0.7,
  happy: 0.7,
};

export function riskOf(
  priority: PriorityT,
  category: CategoryT,
): { score: number; priority: PriorityT } {
  const score = Math.round(IMPACT[priority] * LIKELIHOOD[category] * 100) / 100;
  return { score, priority: score >= 0.7 ? 'P0' : score >= 0.4 ? 'P1' : 'P2' };
}

const allAsserts = (d: Pick<Draft, 'expectations'>) => d.expectations.flatMap((e) => e.asserts);
const allSteps = (d: Pick<Draft, 'setup' | 'steps' | 'expectations'>) => [
  ...d.setup,
  ...d.steps,
  ...d.expectations.flatMap((e) => e.before),
];
const isNegativeApi = (a: Assertion) => a.kind === 'apiStatus' && a.status >= 400;

function categorize(d: Draft): CategoryT {
  if (d.categoryHint) return d.categoryHint;
  const asserts = allAsserts(d);
  const text = [...d.req.given, ...d.req.when, ...d.req.expected.map((e) => e.text)]
    .join(' ')
    .toLowerCase();
  if (/\bconcurrent|at the same time|simultaneous/.test(text)) return 'concurrency';
  if (/\bnetwork|offline|timeout|unavailable\b/.test(text)) return 'network-failure';
  if (
    d.actor === 'anonymous' ||
    asserts.some(
      (a) => (a.kind === 'apiStatus' && [401, 403].includes(a.status)) || a.kind === 'absent',
    )
  ) {
    return 'rbac';
  }
  if (
    allSteps(d).some((s) => s.do === 'login' && s.invalidPassword) ||
    asserts.some((a) => a.kind === 'alert' || isNegativeApi(a))
  ) {
    return 'negative';
  }
  if (
    d.needsSubject &&
    asserts.some(
      (a) =>
        a.kind === 'text' && 'literal' in a.value && a.value.literal !== d.needsSubject?.status,
    )
  ) {
    return 'state-transition';
  }
  return 'happy';
}

/** Insert one login per role on first use, unless the case logs that role in explicitly. */
function withImplicitLogins(steps: Step[], alreadyIn: Set<string>): Step[] {
  const explicit = new Set(steps.filter((s) => s.do === 'login').map((s) => s.as));
  const out: Step[] = [];
  const done = new Set(alreadyIn);
  for (const s of steps) {
    if (s.as !== 'anonymous' && !explicit.has(s.as) && !done.has(s.as)) {
      out.push({ do: 'login', as: s.as, invalidPassword: false, implicit: true });
      done.add(s.as);
    }
    out.push(s);
  }
  return out;
}

function expectationsFor(
  ctx: InterpretContext,
  req: Requirement,
  actor: string,
  lines: Requirement['expected'],
): Expectation[] {
  return lines.map((e) => {
    const r = interpretExpected(ctx, actor, e.text);
    return {
      text: e.text,
      source: e.source,
      requirementId: req.id,
      before: r.before,
      asserts: r.asserts,
    };
  });
}

function draftsFor(ctx: InterpretContext, req: Requirement): Omit<Draft, 'id'>[] {
  const base = { req, setup: [], dependencies: [], data: {}, blockers: [] as string[] };
  if (req.expected.length === 0) {
    return [
      {
        ...base,
        suffix: '',
        actor: req.actors[0] ?? 'anonymous',
        categoryHint: 'happy',
        steps: [],
        expectations: [],
        needsSubject: null,
        blockers: ['no expected result is defined in the requirement'],
      },
    ];
  }
  const given = req.given.map((g) => interpretGiven(req.actors[0] ?? 'anonymous', g));
  const needsSubject = given.find((g) => g.needsSubject)?.needsSubject ?? null;
  const out: Omit<Draft, 'id'>[] = [];

  if (req.when.length === 0) {
    // Independent checks: one case per Expected line.
    for (const e of req.expected) {
      const actor =
        interpretExpected(ctx, req.actors[0] ?? 'anonymous', e.text).asserts[0]?.as ??
        req.actors[0] ??
        'anonymous';
      out.push({
        ...base,
        suffix: ` — ${e.text}`,
        actor,
        categoryHint: null,
        steps: [],
        expectations: expectationsFor(ctx, req, actor, [e]),
        needsSubject,
      });
    }
    return out;
  }

  const whenActors = sentenceActors(req.when[0] ?? '', req.actors);
  const actors = whenActors.length
    ? whenActors
    : [req.actors.find((a) => a !== needsSubject?.creator) ?? req.actors[0] ?? 'anonymous'];
  for (const actor of actors) {
    const givenSteps = req.given.flatMap((g) => interpretGiven(actor, g).steps);
    let whenSteps = req.when.flatMap((w) => interpretWhen(ctx, actor, w));
    // With a subject ("Given: a pending request"), actions of an actor who has not navigated
    // anywhere yet happen on the subject (documented in docs/REQUIREMENTS_FORMAT.md).
    const firstAct = whenSteps.findIndex((s) => s.do === 'fill' || s.do === 'click');
    const navigatedBefore = whenSteps
      .slice(0, Math.max(firstAct, 0))
      .some((s) => s.do === 'goto' || s.do === 'login');
    if (needsSubject && firstAct >= 0 && !navigatedBefore) {
      whenSteps = [
        ...whenSteps.slice(0, firstAct),
        { do: 'goto', as: actor, path: '{{subject.path}}' },
        ...whenSteps.slice(firstAct),
      ];
    }
    const suffix = actors.length > 1 ? ` — as ${actor}` : '';

    if (req.boundaries.length) {
      for (const b of req.boundaries) {
        for (const v of b.values) {
          const steps = [...givenSteps, ...whenSteps].map((s) =>
            s.do === 'fill' && 'ref' in s.value && s.value.ref === `boundary.${b.field}`
              ? { ...s, value: { literal: v } }
              : s,
          );
          const lines = req.expected.filter((e) => e.label === null || e.label === b.label);
          out.push({
            ...base,
            suffix: `${suffix} — ${b.field} ${v} (${b.label})`,
            actor,
            categoryHint: 'boundary',
            steps,
            expectations: expectationsFor(ctx, req, actor, lines),
            needsSubject,
          });
        }
      }
      continue;
    }

    const expectations = expectationsFor(ctx, req, actor, req.expected);
    const negatives = expectations.filter((e) => e.asserts.every(isNegativeApi));
    const positives = expectations.filter((e) => !negatives.includes(e));
    if (negatives.length && positives.length) {
      // A negative API check riding on a positive flow becomes its own negative case.
      out.push({
        ...base,
        suffix,
        actor,
        categoryHint: null,
        steps: [...givenSteps, ...whenSteps],
        expectations: positives,
        needsSubject,
      });
      const accessControl = negatives.every((e) =>
        e.asserts.every((x) => x.kind === 'apiStatus' && [401, 403].includes(x.status)),
      );
      out.push({
        ...base,
        suffix: `${suffix} — ${accessControl ? 'API denies access' : 'API rejects invalid input'}`,
        actor,
        categoryHint: accessControl ? 'rbac' : 'negative',
        steps: givenSteps,
        expectations: negatives,
        needsSubject,
      });
    } else {
      out.push({
        ...base,
        suffix,
        actor,
        categoryHint: null,
        steps: [...givenSteps, ...whenSteps],
        expectations,
        needsSubject,
      });
    }
  }
  return out;
}

const signature = (d: Draft) =>
  JSON.stringify({
    actor: d.actor,
    setup: d.setup,
    steps: d.steps,
    asserts: d.expectations.map((e) => [e.before, e.asserts]),
  });

/** Kahn topological check; returns case IDs that sit on a dependency cycle. */
export function findCycles(deps: Map<string, string[]>): string[][] {
  const indeg = new Map<string, number>();
  for (const id of deps.keys()) indeg.set(id, 0);
  for (const ds of deps.values()) for (const d of ds) if (indeg.has(d)) indeg.set(d, 0);
  for (const [id, ds] of deps)
    for (const d of ds) if (deps.has(d)) indeg.set(id, (indeg.get(id) ?? 0) + 1);
  const queue = [...indeg].filter(([, n]) => n === 0).map(([id]) => id);
  const removed = new Set<string>();
  while (queue.length) {
    const id = queue.shift() ?? '';
    removed.add(id);
    for (const [other, ds] of deps) {
      if (removed.has(other) || !ds.includes(id)) continue;
      const n = (indeg.get(other) ?? 0) - 1;
      indeg.set(other, n);
      if (n === 0) queue.push(other);
    }
  }
  const left = [...deps.keys()].filter((id) => !removed.has(id));
  // Group remaining nodes into strongly connected components (small graphs: simple DFS).
  const cycles: string[][] = [];
  const seen = new Set<string>();
  for (const start of left) {
    if (seen.has(start)) continue;
    const comp = left.filter((n) => reach(deps, start, n) && reach(deps, n, start));
    comp.forEach((n) => seen.add(n));
    if (comp.length) cycles.push(comp.sort());
  }
  return cycles;
}

function reach(deps: Map<string, string[]>, from: string, to: string): boolean {
  const stack = [from];
  const visited = new Set<string>();
  while (stack.length) {
    const n = stack.pop() ?? '';
    for (const d of deps.get(n) ?? []) {
      if (d === to) return true;
      if (!visited.has(d)) {
        visited.add(d);
        stack.push(d);
      }
    }
  }
  return false;
}

/** Final status rules (DRAFT is the initial state of every case). */
export function decideStatus(
  c: Pick<TestCase, 'blockers' | 'steps' | 'setup' | 'expectations'>,
): TestCase['status'] {
  if (c.blockers.some((b) => b.startsWith('BLOCKED:'))) return 'BLOCKED';
  const manual =
    [...c.setup, ...c.steps, ...c.expectations.flatMap((e) => e.before)].some(
      (s) => s.do === 'manual',
    ) || c.expectations.some((e) => e.asserts.some((a) => a.kind === 'manual'));
  if (c.expectations.length === 0 || manual || c.blockers.length > 0) return 'NEEDS_REVIEW';
  return 'READY';
}

/**
 * Statuses from blockers, dependency cycles (BLOCKED) and non-READY dependencies (BLOCKED).
 * Mutates and returns the cases.
 */
export function resolveDependencies<
  T extends Pick<
    TestCase,
    'id' | 'dependencies' | 'blockers' | 'status' | 'setup' | 'steps' | 'expectations'
  >,
>(cases: T[]): T[] {
  const deps = new Map(cases.map((c) => [c.id, c.dependencies]));
  for (const cycle of findCycles(deps)) {
    for (const c of cases)
      if (cycle.includes(c.id))
        c.blockers.push(`BLOCKED: dependency cycle ${cycle.join(' -> ')} -> ${cycle[0] ?? ''}`);
  }
  for (const c of cases) c.status = decideStatus(c);
  // A case is only as runnable as the cases it depends on.
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of cases) {
      if (c.status !== 'READY') continue;
      const bad = c.dependencies.find((id) => cases.find((x) => x.id === id)?.status !== 'READY');
      if (bad) {
        const msg = `BLOCKED: depends on ${bad}, which is not READY`;
        if (!c.blockers.includes(msg)) c.blockers.push(msg);
        c.status = 'BLOCKED';
        changed = true;
      }
    }
  }
  return cases;
}

export function buildPlan(input: PlanInput): TestPlan {
  const { config, requirements, map } = input;
  const roles = [
    ...new Set([...config.roles.map((r) => r.name), ...requirements.flatMap((r) => r.actors)]),
  ];
  const ctx: InterpretContext = { map, roles };

  // 1. Drafts with IDs per requirement.
  const drafts: Draft[] = [];
  for (const req of requirements) {
    draftsFor(ctx, req).forEach((d, i) =>
      drafts.push({ ...d, id: `${req.id}-${String(i + 1).padStart(3, '0')}` }),
    );
  }

  // 2. Subjects: a case needing "a pending X created by Y" gets the producing case as setup.
  for (const d of drafts) {
    if (!d.needsSubject) continue;
    const { status, creator } = d.needsSubject;
    const producer = drafts.find(
      (p) =>
        p !== d &&
        !p.needsSubject &&
        (!creator || p.actor === creator) &&
        p.steps.some((s) => s.do === 'click' && s.capture === 'subject') &&
        allAsserts(p).some(
          (a) => a.kind === 'text' && 'literal' in a.value && a.value.literal === status,
        ) &&
        decideStatus({ ...p, blockers: p.blockers }) === 'READY',
    );
    if (!producer) {
      d.blockers.push(
        `BLOCKED: no READY case produces a "${status}" subject${creator ? ` created by ${creator}` : ''}`,
      );
      continue;
    }
    d.setup = withImplicitLogins(
      producer.steps.filter((s) => s.do !== 'manual'),
      new Set(),
    );
    d.dependencies = [producer.id];
  }

  // 3. Logins, data keys, structural checks.
  for (const d of drafts) {
    // Every role that acts or is asserted on needs a signed-in context, unless the setup already
    // signed it in or the case tests signing in itself.
    const signedIn = new Set(d.setup.filter((s) => s.do === 'login').map((s) => s.as));
    const explicit = new Set(d.steps.filter((s) => s.do === 'login').map((s) => s.as));
    const order = [
      ...d.steps.map((s) => s.as),
      ...d.expectations.flatMap((e) => [
        ...e.before.map((s) => s.as),
        ...e.asserts.map((a) => a.as),
      ]),
    ];
    const needLogin = [...new Set(order)].filter(
      (r) => r !== 'anonymous' && !signedIn.has(r) && !explicit.has(r),
    );
    d.steps = [
      ...needLogin.map((as): Step => ({ do: 'login', as, invalidPassword: false, implicit: true })),
      ...d.steps,
    ];
    for (const s of allSteps(d))
      if (s.do === 'fill' && 'unique' in s.value) d.data[s.value.unique] = 'unique';
    const recordKey = Object.keys(d.data)[0];
    for (const a of d.expectations.flatMap((e) => e.asserts))
      if (a.kind === 'text' && 'ref' in a.value && a.value.ref === RECORD_REF && recordKey)
        a.value = { ref: `data.${recordKey}` };
    const refs = d.expectations
      .flatMap((e) => e.asserts)
      .flatMap((a) => (a.kind === 'text' && 'ref' in a.value ? [a.value.ref] : []));
    for (const r of refs) {
      if (r.startsWith('data.') && !(r.slice(5) in d.data))
        d.blockers.push(`expectation refers to ${r}, which no step provides`);
    }
    const usesSubject = JSON.stringify([d.steps, d.expectations]).includes('{{subject.');
    if (
      usesSubject &&
      !d.setup.length &&
      !d.steps.some((s) => s.do === 'click' && s.capture === 'subject')
    ) {
      if (!d.blockers.some((b) => b.startsWith('BLOCKED:')))
        d.blockers.push('BLOCKED: refers to a subject that no step creates');
    }
    for (const role of new Set([d.actor, ...allSteps(d).map((s) => s.as)])) {
      if (role !== 'anonymous' && !config.roles.some((r) => r.name === role))
        d.blockers.push(`BLOCKED: role "${role}" has no account in the project config`);
    }
    // Threat model T2: destructive steps run only when the owner allowed them in the config.
    if (!config.policy.allowDestructive) {
      const reasons = [...allSteps(d), ...allAsserts(d)]
        .map(destructiveReason)
        .filter((r): r is string => r !== null);
      if (reasons.length) {
        d.blockers.push(
          `BLOCKED: destructive action (${[...new Set(reasons)].join(', ')}) requires policy.allowDestructive in the project config`,
        );
      }
    }
  }

  // 4. Deduplicate identical behaviour + expected outcome.
  const duplicatesMerged: TestPlan['duplicatesMerged'] = [];
  const bySig = new Map<string, Draft>();
  for (const d of drafts) {
    if (d.expectations.length === 0) continue;
    const sig = signature(d);
    const kept = bySig.get(sig);
    if (kept) {
      d.dropped = true;
      duplicatesMerged.push({ kept: kept.id, merged: d.id });
    } else bySig.set(sig, d);
  }
  const live = drafts.filter((d) => !d.dropped);
  const mergedRefs = new Map<string, string[]>();
  for (const { kept, merged } of duplicatesMerged) {
    const src = drafts.find((d) => d.id === merged);
    if (src) mergedRefs.set(kept, [...(mergedRefs.get(kept) ?? []), src.req.id]);
  }

  // 5. Cases with status, risk; then dependency cycles and non-READY producers.
  let cases: TestCase[] = live.map((d) => {
    const category = categorize(d);
    // Merging duplicates never lowers priority: use the highest priority among merged requirements.
    const mergedPriorities = (mergedRefs.get(d.id) ?? []).map(
      (id) => requirements.find((r) => r.id === id)?.priority ?? 'P2',
    );
    const topPriority = [d.req.priority, ...mergedPriorities].sort()[0] ?? d.req.priority;
    const risk = riskOf(topPriority, category);
    const c: TestCase = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      id: d.id,
      title: `${d.req.title}${d.suffix}`,
      feature: d.req.feature,
      scenarioId: `SCN-${d.req.id}`,
      category,
      priority: risk.priority,
      riskScore: risk.score,
      status: 'DRAFT',
      requirementRefs: [...new Set([d.req.id, ...(mergedRefs.get(d.id) ?? [])])],
      actors: [...new Set([d.actor, ...allSteps(d).map((s) => s.as)])].map((role) => ({
        role,
        accountKey: config.roles.find((r) => r.name === role)?.accountKey ?? null,
      })),
      preconditions: d.req.given,
      setup: d.setup,
      steps: d.steps,
      expectations: d.expectations,
      data: d.data,
      dependencies: d.dependencies,
      blockers: d.blockers,
      provenance: {
        requirementSources: [d.req.source, ...d.expectations.map((e) => e.source)],
        mapRefs: d.req.mapRefs,
        generatedBy: 'qa-agent planner (rule-based, no AI)',
      },
      automation: { specPath: null },
    };
    return c;
  });
  resolveDependencies(cases);
  cases = cases.sort((a, b) => b.riskScore - a.riskScore || a.id.localeCompare(b.id));

  const scenarios = requirements.map((r) => ({
    id: `SCN-${r.id}`,
    requirementId: r.id,
    title: r.title,
    caseIds: cases.filter((c) => c.scenarioId === `SCN-${r.id}`).map((c) => c.id),
  }));
  const usedCategories = new Set(cases.map((c) => c.category));
  const plan: TestPlan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    projectId: config.projectId,
    generatedAt: input.generatedAt,
    inputs: { requirementsFiles: input.requirementsFiles, projectMap: input.projectMapPath },
    requirements,
    scenarios,
    cases,
    coverage: {
      requirements: requirements.length,
      withReadyCases: requirements.filter((r) =>
        cases.some((c) => c.requirementRefs.includes(r.id) && c.status === 'READY'),
      ).length,
      needsReview: cases.filter((c) => c.status !== 'READY').map((c) => `${c.id} (${c.status})`),
      categoriesNotRequired: Category.options.filter((c) => !usedCategories.has(c)),
      unreferencedRoutes: unreferencedRoutes(requirements, map),
    },
    duplicatesMerged,
  };
  return TestPlanSchema.parse(plan);
}

/** The only cases a runner may execute: READY, never NEEDS_REVIEW / BLOCKED / DRAFT. */
export function runnableCases(plan: Pick<TestPlan, 'cases'>): TestCase[] {
  return plan.cases.filter((c) => c.status === 'READY');
}

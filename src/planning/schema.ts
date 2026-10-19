// Planning contracts: Requirement → TestScenario → TestCase → TestPlan (schemaVersion 1).
// Steps and assertions are structured so the P4 generator can emit Playwright code without AI.

import { z } from 'zod';

export const PLAN_SCHEMA_VERSION = 1;

export const Priority = z.enum(['P0', 'P1', 'P2']);
export const Category = z.enum([
  'happy',
  'negative',
  'boundary',
  'rbac',
  'state-transition',
  'network-failure',
  'concurrency',
]);
export const CaseStatus = z.enum(['DRAFT', 'NEEDS_REVIEW', 'READY', 'BLOCKED']);

export const SourceLine = z.object({ file: z.string(), line: z.int().positive() });

export const RequirementSchema = z.object({
  schemaVersion: z.literal(PLAN_SCHEMA_VERSION),
  id: z.string().regex(/^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/),
  title: z.string().min(1),
  feature: z.string().nullable(),
  priority: Priority,
  actors: z.array(z.string()),
  given: z.array(z.string()),
  when: z.array(z.string()),
  expected: z.array(
    z.object({ text: z.string(), label: z.string().nullable(), source: SourceLine }),
  ),
  rules: z.array(z.string()),
  boundaries: z.array(
    z.object({ label: z.string(), field: z.string(), values: z.array(z.string()) }),
  ),
  notes: z.array(z.string()),
  source: SourceLine,
  /** Project-map items the requirement mentions (paths, quoted UI names). Support, not evidence of expectations. */
  mapRefs: z.array(z.string()),
});

/** A value used in a step: literal, generated unique text, or a value captured earlier. */
export const Value = z.union([
  z.object({ literal: z.string() }),
  z.object({ unique: z.string() }), // e.g. "title" → "QA title <runId>-<n>"
  z.object({ ref: z.string() }), // e.g. "subject.id"
]);

export const StepSchema = z.discriminatedUnion('do', [
  z.object({
    do: z.literal('login'),
    as: z.string(),
    invalidPassword: z.boolean().default(false),
    /** Inserted by the planner so a role can act; false when the requirement tests signing in. */
    implicit: z.boolean().default(false),
  }),
  z.object({ do: z.literal('goto'), as: z.string(), path: z.string() }),
  z.object({ do: z.literal('fill'), as: z.string(), label: z.string(), value: Value }),
  z.object({
    do: z.literal('click'),
    as: z.string(),
    role: z.enum(['button', 'link']),
    name: z.string(),
    capture: z.string().optional(),
  }),
  z.object({ do: z.literal('manual'), as: z.string(), text: z.string() }),
]);

export const AssertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), as: z.string(), path: z.string() }),
  z.object({ kind: z.literal('heading'), as: z.string(), name: z.string() }),
  z.object({ kind: z.literal('text'), as: z.string(), value: Value }),
  z.object({ kind: z.literal('alert'), as: z.string(), text: z.string() }),
  z.object({
    kind: z.literal('absent'),
    as: z.string(),
    role: z.enum(['button', 'link']),
    name: z.string(),
  }),
  z.object({
    kind: z.literal('apiStatus'),
    as: z.string(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string(), // may contain {{subject.id}}
    body: z.record(z.string(), z.string()).optional(),
    status: z.int().min(100).max(599),
  }),
  z.object({ kind: z.literal('apiCountUnchanged'), as: z.string(), path: z.string() }),
  z.object({ kind: z.literal('manual'), as: z.string(), text: z.string() }),
]);

export const ExpectationSchema = z.object({
  /** Verbatim requirement sentence — the only accepted source of an expected result. */
  text: z.string(),
  source: SourceLine,
  requirementId: z.string(),
  /** Navigation needed before asserting (e.g. open the subject as another role). */
  before: z.array(StepSchema).default([]),
  asserts: z.array(AssertionSchema).min(1),
});

export const TestCaseSchema = z.object({
  schemaVersion: z.literal(PLAN_SCHEMA_VERSION),
  id: z.string().regex(/^[A-Z0-9-]+-\d{3}$/),
  title: z.string(),
  feature: z.string().nullable(),
  scenarioId: z.string(),
  category: Category,
  priority: Priority,
  riskScore: z.number().min(0).max(1),
  status: CaseStatus,
  requirementRefs: z.array(z.string()).min(1),
  actors: z.array(z.object({ role: z.string(), accountKey: z.string().nullable() })),
  preconditions: z.array(z.string()),
  /** Steps that create the case's subject (inlined from the producing case). */
  setup: z.array(StepSchema),
  steps: z.array(StepSchema),
  expectations: z.array(ExpectationSchema),
  data: z.record(z.string(), z.string()).default({}),
  dependencies: z.array(z.string()),
  blockers: z.array(z.string()),
  provenance: z.object({
    requirementSources: z.array(SourceLine),
    mapRefs: z.array(z.string()),
    generatedBy: z.string(),
  }),
  automation: z.object({ specPath: z.string().nullable() }),
});

export const TestScenarioSchema = z.object({
  id: z.string(),
  requirementId: z.string(),
  title: z.string(),
  caseIds: z.array(z.string()),
});

export const TestPlanSchema = z.object({
  schemaVersion: z.literal(PLAN_SCHEMA_VERSION),
  projectId: z.string(),
  generatedAt: z.string(),
  inputs: z.object({ requirementsFiles: z.array(z.string()), projectMap: z.string().nullable() }),
  requirements: z.array(RequirementSchema),
  scenarios: z.array(TestScenarioSchema),
  cases: z.array(TestCaseSchema),
  coverage: z.object({
    requirements: z.int(),
    withReadyCases: z.int(),
    needsReview: z.array(z.string()),
    categoriesNotRequired: z.array(Category),
    unreferencedRoutes: z.array(z.string()),
  }),
  duplicatesMerged: z.array(z.object({ kept: z.string(), merged: z.string() })),
});

export type Requirement = z.infer<typeof RequirementSchema>;
export type ValueT = z.infer<typeof Value>;
export type Step = z.infer<typeof StepSchema>;
export type Assertion = z.infer<typeof AssertionSchema>;
export type Expectation = z.infer<typeof ExpectationSchema>;
export type TestCase = z.infer<typeof TestCaseSchema>;
export type TestScenario = z.infer<typeof TestScenarioSchema>;
export type TestPlan = z.infer<typeof TestPlanSchema>;
export type CategoryT = z.infer<typeof Category>;
export type PriorityT = z.infer<typeof Priority>;

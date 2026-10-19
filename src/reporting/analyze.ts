// Failure analysis, first pass (rule-based, deterministic). The plugin's `failure-analyzer` agent
// may add a second opinion (ai-analysis.json); neither ever edits tests or expected results.

import type { TestPlan } from '../planning/schema.ts';
import type { NormalizedResult } from './normalize.ts';

export type FailureClass =
  'probable_app_bug' | 'test_automation_issue' | 'environment_issue' | 'insufficient_evidence';

export interface FailureAnalysis {
  caseId: string;
  classification: FailureClass;
  confidence: number; // 0..1
  rationale: string;
  evidence: string[];
  source: 'rules' | 'ai';
}

interface Rule {
  test: RegExp;
  classification: FailureClass;
  confidence: number;
  rationale: string;
}

const RULES: Rule[] = [
  {
    test: /QA_AGENT_BLOCKED/,
    classification: 'environment_issue',
    confidence: 0.95,
    rationale:
      'A precondition outside the application is missing (credentials, role or allowed origin).',
  },
  {
    test: /ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|net::ERR_ADDRESS_UNREACHABLE/,
    classification: 'environment_issue',
    confidence: 0.9,
    rationale: 'The application could not be reached.',
  },
  {
    test: /Executable doesn't exist|browserType\.launch|Failed to launch|Target page, context or browser has been closed/,
    classification: 'environment_issue',
    confidence: 0.8,
    rationale: 'The browser could not be started or was closed unexpectedly.',
  },
  {
    test: /strict mode violation/,
    classification: 'test_automation_issue',
    confidence: 0.8,
    rationale: 'A locator matched several elements; the generated locator is not specific enough.',
  },
  {
    test: /SyntaxError|TypeError|ReferenceError|is not a function|Cannot read properties of/,
    classification: 'test_automation_issue',
    confidence: 0.85,
    rationale: 'The test code itself raised a programming error.',
  },
  {
    test: /Expected: \d{3}\s+Received: \d{3}/,
    classification: 'probable_app_bug',
    confidence: 0.85,
    rationale: 'The application answered with a different HTTP status than the requirement states.',
  },
  {
    test: /toHaveCount|Expected: 0\s+Received: [1-9]/,
    classification: 'probable_app_bug',
    confidence: 0.75,
    rationale: 'An element or record that the requirement says must not exist was found.',
  },
  {
    test: /Expected (string|pattern|substring)?:?[\s\S]*Received (string|pattern)?:?/,
    classification: 'probable_app_bug',
    confidence: 0.7,
    rationale: 'The page showed a different value than the requirement states.',
  },
  {
    test: /element\(s\) not found|waiting for (get|locator)|toBeVisible/,
    classification: 'insufficient_evidence',
    confidence: 0.4,
    rationale:
      'An expected element did not appear. This is either missing behaviour (app bug) or a changed UI/locator (automation issue); inspect the trace and screenshot.',
  },
  {
    test: /Test timeout of \d+ms exceeded/,
    classification: 'insufficient_evidence',
    confidence: 0.3,
    rationale:
      'The test timed out; the cause (slow app, wrong wait, environment) is not visible in the error.',
  },
];

export function analyzeFailures(
  results: NormalizedResult[],
  plan: Pick<TestPlan, 'cases'>,
): FailureAnalysis[] {
  const failedIds = new Set(results.filter((r) => r.status === 'FAIL').map((r) => r.caseId));
  return results
    .filter((r) => r.status === 'FAIL' || r.status === 'BLOCKED')
    .map((r): FailureAnalysis => {
      const msg = r.error?.message ?? '';
      const c = plan.cases.find((x) => x.id === r.caseId);
      const evidence: string[] = [];
      if (r.error)
        evidence.push(`error: ${msg.split('\n').filter(Boolean).slice(0, 6).join(' | ')}`);
      if (r.error?.location) evidence.push(`at ${r.error.location}`);
      const expectation = c?.expectations.find((e) => msg.includes(e.text.slice(0, 40))) ?? null;
      for (const e of c?.expectations ?? []) {
        if (expectation === null || e === expectation)
          evidence.push(
            `requirement ${e.requirementId} (${e.source.file}:${e.source.line}): "${e.text}"`,
          );
      }
      for (const a of r.attachments)
        if (/trace|screenshot|video/.test(a.name)) evidence.push(`${a.name}: ${a.path}`);
      const failedDeps = r.dependsOn.filter((d) => failedIds.has(d));

      if (r.status === 'BLOCKED' && !r.error) {
        return {
          caseId: r.caseId,
          classification: 'environment_issue',
          confidence: 0.9,
          rationale: r.note ?? 'blocked by the plan',
          evidence,
          source: 'rules',
        };
      }
      if (failedDeps.length) {
        return {
          caseId: r.caseId,
          classification: 'insufficient_evidence',
          confidence: 0.5,
          rationale: `Its setup comes from ${failedDeps.join(', ')}, which failed in the same run; fix that first.`,
          evidence,
          source: 'rules',
        };
      }
      const rule = RULES.find((x) => x.test.test(msg));
      return rule
        ? {
            caseId: r.caseId,
            classification: rule.classification,
            confidence: rule.confidence,
            rationale: rule.rationale,
            evidence,
            source: 'rules',
          }
        : {
            caseId: r.caseId,
            classification: 'insufficient_evidence',
            confidence: 0.2,
            rationale: 'No rule matched the failure; review the trace before deciding.',
            evidence,
            source: 'rules',
          };
    });
}

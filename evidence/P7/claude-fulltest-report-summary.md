# QA report — sample-approvals — run-20261019T142657-v9nz

## Executive summary

- **Result:** 2 failed, 0 blocked, 0 runnable case(s) not run. Passed 18 / executed 20 (ready 20, generated 22); skipped 0, not run 2, flaky 0.
- **Requirements:** 12 in scope; 11 with runnable cases (requirement coverage 92%); 10 fully passing.
- **Run:** 2026-10-19T14:26:57.146Z → 2026-10-19T14:27:54.748Z on http://127.0.0.1:62577/ (local); build unknown; chromium (channel chrome); Playwright 1.63.0; QA Agent 0.1.0.
- PASS/FAIL comes from Playwright assertions. Failure classifications are explanations with a confidence, not verdicts.

## Failures and blocked cases

| Case | Status | Classification | Confidence | Source | Rationale |
|---|---|---|---|---|---|
| DEMO-REQ-APP-003-002 | FAIL | probable_app_bug | 0.85 | rules | The application answered with a different HTTP status than the requirement states. |
| DEMO-REQ-APP-003-004 | FAIL | probable_app_bug | 0.85 | rules | The application answered with a different HTTP status than the requirement states. |
| DEMO-REQ-APP-003-002 | FAIL | probable_app_bug | 0.95 | ai | The API endpoint POST /api/requests/<id>/approve accepted a request made with the requester session and returned HTTP 200. The requirement explicitly mandates HTTP 403 for non-approvers. The test code is correct: it sends the request under the 'requester' actor and asserts status 403. The companion UI test (DEMO-REQ-APP-003-001) passed, confirming the session and request setup are sound. The failure is a direct contradiction of the stated requirement by the application. |
| DEMO-REQ-APP-003-004 | FAIL | probable_app_bug | 0.95 | ai | The API endpoint POST /api/requests/<id>/approve accepted a request made with the viewer session and returned HTTP 200. The requirement explicitly mandates HTTP 403 for non-approvers (including viewers). The test code is correct: it sends the request under the 'viewer' actor and asserts status 403. The companion UI test (DEMO-REQ-APP-003-003) passed, confirming the session and request setup are sound. The failure is a direct contradiction of the stated requirement by the application, and is consistent with the same bug observed in DEMO-REQ-APP-003-002. |

### DEMO-REQ-APP-003-002

- error: Error: POST /api/requests/REQ-9/approve as requester \| expect(received).toBe(expected) // Object.is equality \| Expected: 403 \| Received: 200
- at e2e/generated/approval.spec.ts:205:13
- requirement DEMO-REQ-APP-003 (docs/requirements.md:116): "`POST /api/requests/<id>/approve` returns HTTP 403 for them"
- screenshot: qa-artifacts/runs/run-20261019T142657-v9nz/test-results-parallel/approval-Approval-DEMO-REQ-ac926-quester-—-API-denies-access-chromium/test-failed-1.png
- trace: qa-artifacts/runs/run-20261019T142657-v9nz/test-results-parallel/approval-Approval-DEMO-REQ-ac926-quester-—-API-denies-access-chromium/trace.zip

### DEMO-REQ-APP-003-004

- error: Error: POST /api/requests/REQ-11/approve as viewer \| expect(received).toBe(expected) // Object.is equality \| Expected: 403 \| Received: 200
- at e2e/generated/approval.spec.ts:280:96
- requirement DEMO-REQ-APP-003 (docs/requirements.md:116): "`POST /api/requests/<id>/approve` returns HTTP 403 for them"
- screenshot: qa-artifacts/runs/run-20261019T142657-v9nz/test-results-parallel/approval-Approval-DEMO-REQ-7ce5d--viewer-—-API-denies-access-chromium/test-failed-1.png
- screenshot: qa-artifacts/runs/run-20261019T142657-v9nz/test-results-parallel/approval-Approval-DEMO-REQ-7ce5d--viewer-—-API-denies-access-chromium/test-failed-2.png
- trace: qa-artifacts/runs/run-20261019T142657-v9nz/test-results-parallel/approval-Approval-DEMO-REQ-7ce5d--viewer-—-API-denies-access-chromium/trace.zip

## Requirement coverage

| Requirement | Priority | Verdict | Cases |
|---|---|---|---|
| DEMO-REQ-AUTH-001 — Sign in with valid credentials | P0 | passing | DEMO-REQ-AUTH-001-001 PASS |
| DEMO-REQ-AUTH-002 — Reject invalid credentials | P1 | passing | DEMO-REQ-AUTH-002-001 PASS |
| DEMO-REQ-AUTH-003 — Protect pages from anonymous users | P0 | passing | DEMO-REQ-AUTH-003-001 PASS, DEMO-REQ-AUTH-003-002 PASS |
| DEMO-REQ-REQ-001 — Create a purchase request | P0 | passing | DEMO-REQ-REQ-001-001 PASS |
| DEMO-REQ-REQ-002 — Title is required | P1 | passing | DEMO-REQ-REQ-002-001 PASS |
| DEMO-REQ-REQ-003 — Amount limits | P1 | passing | DEMO-REQ-REQ-003-001 PASS, DEMO-REQ-REQ-003-002 PASS, DEMO-REQ-REQ-003-003 PASS, DEMO-REQ-REQ-003-004 PASS |
| DEMO-REQ-REQ-004 — Requests are easy to find | P2 | needs-review | DEMO-REQ-REQ-004-001 NOT_RUN (NEEDS_REVIEW) |
| DEMO-REQ-APP-001 — Approver approves a pending request | P0 | passing | DEMO-REQ-APP-001-001 PASS |
| DEMO-REQ-APP-002 — Approver rejects with a reason | P1 | passing | DEMO-REQ-APP-002-001 PASS, DEMO-REQ-APP-002-002 PASS |
| DEMO-REQ-APP-003 — Only approvers can decide | P0 | failing | DEMO-REQ-APP-003-001 PASS, DEMO-REQ-APP-003-002 FAIL, DEMO-REQ-APP-003-003 PASS, DEMO-REQ-APP-003-004 FAIL |
| DEMO-REQ-VIEW-001 — Viewer is read-only | P1 | passing | DEMO-REQ-VIEW-001-002 PASS, DEMO-REQ-VIEW-001-003 PASS, DEMO-REQ-VIEW-001-001 NOT_RUN (NEEDS_REVIEW) |
| DEMO-REQ-APP-004 — Decision is visible in another tab | P2 | passing | DEMO-REQ-APP-004-001 PASS |

## All cases

| Case | Status | Category | Priority | Duration | Phase | Requirements |
|---|---|---|---|---|---|---|
| DEMO-REQ-APP-003-001 | PASS | rbac | P0 | 2.6s | parallel | DEMO-REQ-APP-003 |
| DEMO-REQ-APP-003-002 | FAIL | rbac | P0 | 2.6s | parallel | DEMO-REQ-APP-003 |
| DEMO-REQ-APP-003-003 | PASS | rbac | P0 | 2.9s | parallel | DEMO-REQ-APP-003 |
| DEMO-REQ-APP-003-004 | FAIL | rbac | P0 | 2.3s | parallel | DEMO-REQ-APP-003 |
| DEMO-REQ-AUTH-003-001 | PASS | rbac | P0 | 1.4s | parallel | DEMO-REQ-AUTH-003 |
| DEMO-REQ-AUTH-003-002 | PASS | rbac | P0 | 0.2s | parallel | DEMO-REQ-AUTH-003 |
| DEMO-REQ-APP-001-001 | PASS | state-transition | P0 | 18.6s | parallel | DEMO-REQ-APP-001 |
| DEMO-REQ-AUTH-001-001 | PASS | happy | P0 | 5.7s | parallel | DEMO-REQ-AUTH-001 |
| DEMO-REQ-REQ-001-001 | PASS | happy | P0 | 2.4s | parallel | DEMO-REQ-REQ-001 |
| DEMO-REQ-VIEW-001-002 | PASS | rbac | P1 | 10.8s | parallel | DEMO-REQ-VIEW-001 |
| DEMO-REQ-VIEW-001-003 | PASS | rbac | P1 | 2.4s | parallel | DEMO-REQ-VIEW-001 |
| DEMO-REQ-APP-002-001 | PASS | state-transition | P1 | 4.7s | parallel | DEMO-REQ-APP-002 |
| DEMO-REQ-APP-002-002 | PASS | negative | P1 | 3.2s | parallel | DEMO-REQ-APP-002 |
| DEMO-REQ-AUTH-002-001 | PASS | negative | P1 | 2.4s | parallel | DEMO-REQ-AUTH-002 |
| DEMO-REQ-REQ-002-001 | PASS | negative | P1 | 2.3s | serial | DEMO-REQ-REQ-002 |
| DEMO-REQ-REQ-003-001 | PASS | boundary | P1 | 1.7s | parallel | DEMO-REQ-REQ-003 |
| DEMO-REQ-REQ-003-002 | PASS | boundary | P1 | 2.0s | parallel | DEMO-REQ-REQ-003 |
| DEMO-REQ-REQ-003-003 | PASS | boundary | P1 | 1.8s | parallel | DEMO-REQ-REQ-003 |
| DEMO-REQ-REQ-003-004 | PASS | boundary | P1 | 1.4s | parallel | DEMO-REQ-REQ-003 |
| DEMO-REQ-VIEW-001-001 | NOT_RUN | happy | P1 | 0.0s | — | DEMO-REQ-VIEW-001 |
| DEMO-REQ-APP-004-001 | PASS | state-transition | P2 | 2.4s | parallel | DEMO-REQ-APP-004 |
| DEMO-REQ-REQ-004-001 | NOT_RUN | happy | P2 | 0.0s | — | DEMO-REQ-REQ-004 |

## Not run / blocked by the plan

- DEMO-REQ-VIEW-001-001: plan status NEEDS_REVIEW: needs review
- DEMO-REQ-REQ-004-001: plan status NEEDS_REVIEW: no expected result is defined in the requirement

## Artifacts

- Run record: `qa-artifacts/runs/run-20261019T142657-v9nz/run.json`
- Playwright HTML report: `qa-artifacts/runs/run-20261019T142657-v9nz/html-parallel/index.html`
- Playwright HTML report: `qa-artifacts/runs/run-20261019T142657-v9nz/html-serial/index.html`
- Traces and screenshots of failed tests are listed per failure. **They can contain session data and typed values; do not share them outside the team.**

# Demo walkthrough (sample app)

All commands run from the QA Agent repository root on Windows PowerShell. Bash works the same with `export` instead of `$env:`. The sample app is a local fixture: the demo passwords below belong to it, not to any real system.

## 1. Start the sample app

```powershell
$env:SAMPLE_APP_TEST_MODE = '1'          # enables the test-data reset endpoint
node examples/sample-app/server.mjs 4100  # http://127.0.0.1:4100 — keep this terminal open
```

Open `http://127.0.0.1:4100`: sign in as `alice` / `alice-demo` (requester), `bob` / `bob-demo` (approver) or `victor` / `victor-demo` (viewer). The requirements are in `examples/sample-app/docs/requirements.md`.

## 2. Provide the role credentials (second terminal)

```powershell
$env:QA_AGENT_ACCOUNT_DEMO_REQUESTER_USERNAME = 'alice'; $env:QA_AGENT_ACCOUNT_DEMO_REQUESTER_PASSWORD = 'alice-demo'
$env:QA_AGENT_ACCOUNT_DEMO_APPROVER_USERNAME  = 'bob';   $env:QA_AGENT_ACCOUNT_DEMO_APPROVER_PASSWORD  = 'bob-demo'
$env:QA_AGENT_ACCOUNT_DEMO_VIEWER_USERNAME    = 'victor'; $env:QA_AGENT_ACCOUNT_DEMO_VIEWER_PASSWORD   = 'victor-demo'
$env:QA_AGENT_BROWSER_CHANNEL = 'chrome'
```

## 3. Run the stages

```powershell
npm run qa -- discover --project examples/sample-app
```

The config, docs and `server.mjs` are read (read-only); the app is explored through Playwright MCP, signed in as the requester. Output: `.qa-agent/discovery/project-map.json`, where every route, form, UI element and role has `sources` (file:line), provenance and `observedIn` links to `observations.json`.

```powershell
npm run qa -- plan --project examples/sample-app
```

Result: 22 cases from 12 requirements, 20 READY. Open `.qa-agent/plan/test-plan.md`: each expectation quotes its requirement line, and DEMO-REQ-REQ-004 ("easy to find") is `NEEDS_REVIEW` because it has no measurable expected result.

```powershell
npm run qa -- generate --validate --project examples/sample-app
```

This writes `e2e/generated/*.spec.ts`, type-checks them and lists 20 tests with Playwright. Run it again: nothing is rewritten.

```powershell
npm run qa -- run --project examples/sample-app
```

19 isolated cases run in parallel (2 workers), then 1 shared-state case serially. Requester, approver and viewer each get their own browser context; one case uses a second requester tab.

```powershell
npm run qa -- report --project examples/sample-app
```

The command prints the counts. Open `examples/sample-app/qa-artifacts/runs/<runId>/report/report.html` or `summary.md`.

All of the above at once: `npm run qa -- full-test --project examples/sample-app` (add `--resume` to skip unchanged stages).

## 4. See a real defect being caught

Stop the app and restart it with the intentional defect, then run and report again:

```powershell
$env:SAMPLE_APP_BUG = 'skip-approve-rbac'; node examples/sample-app/server.mjs 4100
npm run qa -- run --project examples/sample-app; npm run qa -- report --project examples/sample-app
```

`DEMO-REQ-APP-003-002` and `-004` fail with "Expected: 403, Received: 200", classified `probable_app_bug` (0.85), with the requirement line, trace and screenshot as evidence. The UI checks (no "Approve" button) still pass: a hidden button is not proof of authorization.

## 5. The same from Claude Code

```powershell
cd examples/sample-app
claude --plugin-dir ..\..
```

Then `/qa-agent:full-test`. For failures, the `report` skill asks the read-only `failure-analyzer` agent for a second opinion and stores it as `ai-analysis.json`.

The one-command version of this walkthrough (fresh copy, fresh app, evidence folder) is `node scripts/smoke/vertical-slice.mjs [--bug skip-approve-rbac] [--out <dir>]`.

---
description: "QA Agent test execution. Runs the generated Playwright suite of the target project with isolated role contexts: data-isolated cases in parallel within the worker budget, shared-state cases serially, and records the run under qa-artifacts/runs/. Use when the user asks to run or execute the generated tests."
argument-hint: "[--project <dir>]"
disable-model-invocation: true
---

# QA Agent — run

Status: **implemented (P5)**. Arguments: $ARGUMENTS

1. Preconditions: `/qa-agent:generate` has produced `<testOutputRoot>/` (with `case-map.json`), the app is running at the configured `baseURL`, and the target project has `@playwright/test` and a browser.
2. Safety: run only against the configured `local` / `staging` environment. Never point `QA_AGENT_BASE_URL` at production or at an origin outside `allowedOrigins` (the runtime refuses it anyway). The run may call the configured `testData.resetPath`.
3. Credentials: the user provides `QA_AGENT_ACCOUNT_<ACCOUNT_KEY>_USERNAME` / `_PASSWORD` in their environment for each role. Never ask for passwords in chat, never write them to files, never echo or print them (to check presence use only `node -e "for (const k of Object.keys(process.env).filter((k) => k.startsWith('QA_AGENT_ACCOUNT_'))) console.log(k, process.env[k] ? 'set' : 'MISSING')"`). A missing variable makes the affected tests fail with `QA_AGENT_BLOCKED: …`; report those as BLOCKED, not as app bugs.
4. Run the engine with the Bash tool (plugin root `${CLAUDE_PLUGIN_ROOT}`; if not substituted, use the directory containing this plugin's `.claude-plugin/plugin.json`):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/qa-agent.mjs" run --project "<project root>"
   ```

5. Report exactly what Playwright reported per phase (`parallel` / `serial`): passed, failed, skipped, flaky, plus the run ID and the paths `qa-artifacts/runs/<runId>/run.json`, `results-*.json`, `schedule.json`. PASS/FAIL is Playwright's verdict, not yours. Detailed reporting and failure analysis belong to `/qa-agent:report`.
6. Do not re-run failing tests until they pass, edit specs, or raise retries to hide failures. Flaky results must be reported as flaky.

End with the line `QA-AGENT-SKILL: run | status=implemented | phase=P5`.

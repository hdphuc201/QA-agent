---
description: "QA Agent end-to-end pipeline. Runs discover, plan, generate (with validation), run and report for the target project in one go, resumable after an interruption, and summarises the result. Use when the user asks for a full test run of an app."
argument-hint: "[--offline] [--resume]"
disable-model-invocation: true
---

# QA Agent — full-test

Status: **implemented (P7)**. Arguments: $ARGUMENTS

1. Preconditions (check them and stop with a clear list if one is missing — never guess):
   - `.qa-agent/config.json` in the project (see `/qa-agent:discover`);
   - the app is running at the configured `baseURL` (local or staging only, never production);
   - `QA_AGENT_ACCOUNT_<ACCOUNT_KEY>_USERNAME/_PASSWORD` for each role are set in the user's environment (never ask for them in chat). Check them **without printing values**, only with:
     `node -e "for (const k of Object.keys(process.env).filter((k) => k.startsWith('QA_AGENT_ACCOUNT_'))) console.log(k, process.env[k] ? 'set' : 'MISSING')"`
     Never `echo`, `printenv` or otherwise output a credential value;
   - `@playwright/test` installed in the project.
2. Run the pipeline with the Bash tool (plugin root `${CLAUDE_PLUGIN_ROOT}`; if not substituted, use the directory containing this plugin's `.claude-plugin/plugin.json`):

   ```bash
   node --experimental-strip-types --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" full-test --project "<project root>" $ARGUMENTS
   ```

   `--offline` skips live exploration; `--resume` skips stages that finished before with unchanged inputs (state in `.qa-agent/full-test-state.json`).

3. If a stage failed, report the stage and its message and stop; the next `--resume` restarts from it. Test failures are not a stage failure: the run and report stages still complete.
4. **Failure analysis (required when the report lists any FAIL or BLOCKED case).** The run ID is in the output (`report run-…`) and in `.qa-agent/full-test-state.json` (`runId`).
   1. Call the Task tool with `subagent_type: "qa-agent:failure-analyzer"` and a prompt that gives the project root and the run ID. The agent is read-only and answers with a JSON array.
   2. Write that array unchanged with the Write tool to `<project root>/qa-artifacts/runs/<runId>/ai-analysis.json`.
   3. Re-run only the report so the analysis is validated and merged:

      ```bash
      node --experimental-strip-types --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" report --project "<project root>" --run <runId>
      ```

   Skip this step only when every executed case passed.

5. Summarise `qa-artifacts/runs/<runId>/report/summary.md`: counts kept apart (generated, ready, executed, passed, failed, blocked, skipped, not run, flaky), each failure with its rule-based and AI classification (confidence, source) and evidence, requirement coverage, and the paths of `report.html`, the Playwright HTML reports, traces and screenshots. PASS/FAIL is Playwright's verdict; classifications only explain it.
6. Never edit generated specs, plans or requirements to make results look better.

End with the line `QA-AGENT-SKILL: full-test | status=implemented | phase=P7`.

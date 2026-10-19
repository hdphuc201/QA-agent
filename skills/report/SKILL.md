---
description: "QA Agent reporting. Normalises the latest (or a given) run to PASS/FAIL/SKIPPED/BLOCKED/NOT_RUN per case, classifies failures with evidence and confidence, builds requirement coverage and writes results.json, summary.md and report.html. Use when the user asks for test results, a QA report or failure analysis."
argument-hint: "[--run <runId>]"
disable-model-invocation: true
---

# QA Agent — report

Status: **implemented (P7)**. Arguments: $ARGUMENTS

1. Build the report with the Bash tool (plugin root `${CLAUDE_PLUGIN_ROOT}`; if not substituted, use the directory containing this plugin's `.claude-plugin/plugin.json`):

   ```bash
   node --experimental-strip-types --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" report --project "<project root>" $ARGUMENTS
   ```

   Exit code 1 means some cases failed or were blocked; that is a result, not an error of the command.

2. **Required when there are FAIL or BLOCKED cases:** call the Task tool with `subagent_type: "qa-agent:failure-analyzer"` and a prompt containing the project root and the run ID printed by the command. The agent is read-only and returns a JSON array. Write that array unchanged with the Write tool to `qa-artifacts/runs/<runId>/ai-analysis.json`, then run the report command again with `--run <runId>` so it is validated and merged (entries that do not match a failing case or the schema are rejected and listed under "AI analysis notes"). Skip this only when every executed case passed.
3. Present `qa-artifacts/runs/<runId>/report/summary.md`:
   - counts kept apart: generated, ready, executed, passed, failed, blocked, skipped, not run, flaky;
   - each failure with status, rule-based and AI classification (with confidence and source), and the evidence lines;
   - requirement coverage (requirement → cases → result) and requirements without runnable cases;
   - the paths of `report.html`, the Playwright HTML reports, traces and screenshots.
4. Rules:
   - PASS/FAIL is Playwright's verdict. Classifications explain; they never overturn it.
   - Never edit tests, specs, plans or requirements to change a result. Never call a requirement "covered" because many tests exist.
   - Traces and screenshots can contain session data: mention their paths, do not paste their contents.

End with the line `QA-AGENT-SKILL: report | status=implemented | phase=P7`.

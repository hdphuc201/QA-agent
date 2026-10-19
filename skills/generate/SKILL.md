---
description: "QA Agent spec generation. Generates Playwright Test .spec.ts files, shared fixtures and a Playwright config from the READY cases of .qa-agent/plan/test-plan.json into the project's testOutputRoot, then type-checks and lists them. Use when the user asks to generate or update automated tests."
argument-hint: "[--no-validate]"
disable-model-invocation: true
---

# QA Agent — generate

Status: **implemented (P4)**. Arguments: $ARGUMENTS

1. Requires `.qa-agent/plan/test-plan.json` (`/qa-agent:plan`). Only `READY` cases are generated; report the skipped `NEEDS_REVIEW` / `BLOCKED` ones by ID.
2. The target project needs `@playwright/test` installed. If validation reports `BLOCKED: the target project has no @playwright/test installed`, tell the user to install it (`npm i -D @playwright/test`) — do not install it yourself without consent.
3. Run the deterministic generator with the Bash tool (plugin root `${CLAUDE_PLUGIN_ROOT}`; if not substituted, use the directory that contains this plugin's `.claude-plugin/plugin.json`). Add `--validate` unless `$ARGUMENTS` contains `--no-validate`:

   ```bash
   node --experimental-strip-types --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" generate --validate --project "<project root>"
   ```

4. Report the written / unchanged / removed files, the type-check result and how many tests `playwright --list` found versus READY cases.
5. Conflicts: a generated file the user edited (or a non-QA-Agent file with the same name) is never overwritten; the new version is written next to it as `*.qa-agent-new`. Show these and let the user merge them. Never resolve a conflict by editing the generated assertions.
6. Never hand-edit generated specs to make them pass. If a test is wrong, the requirement or the plan must change, and then the user regenerates.

The suite runs with `npx playwright test -c <testOutputRoot>/playwright.qa-agent.config.ts` (see `/qa-agent:run`).

End with the line `QA-AGENT-SKILL: generate | status=implemented | phase=P4`.

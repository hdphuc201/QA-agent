---
description: "QA Agent reporting (skeleton). Will normalise Playwright results, classify failures and produce Markdown/JSON/HTML reports. Not implemented yet."
argument-hint: "[run-id]"
disable-model-invocation: true
---

# QA Agent — report (skeleton)

Status: **skeleton** — implementation is planned for phase P7 of `QA_AGENT_MASTER_ROADMAP.md`.

Planned behaviour: Normalise results to PASS/FAIL/SKIPPED/BLOCKED/NOT_RUN, link them to case IDs and requirements, classify failures with confidence, and write Markdown, JSON and HTML reports.

## When invoked now

1. Tell the user this skill is a skeleton and that phase P7 implements it.
2. Do not explore, plan, generate, run or report anything on its behalf, and never present invented results as QA output.
3. Echo the arguments received: $ARGUMENTS
4. End with the line `QA-AGENT-SKILL: report | status=skeleton | phase=P7`.

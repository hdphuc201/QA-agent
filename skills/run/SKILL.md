---
description: "QA Agent test execution (skeleton). Will run generated Playwright Test suites with isolated role contexts and worker budgets. Not implemented yet."
argument-hint: "[suite]"
disable-model-invocation: true
---

# QA Agent — run (skeleton)

Status: **skeleton** — implementation is planned for phase P5 of `QA_AGENT_MASTER_ROADMAP.md`.

Planned behaviour: Run `npx playwright test` for generated specs with per-role browser contexts, safe worker budgets and evidence capture; never against production without explicit approval.

## When invoked now

1. Tell the user this skill is a skeleton and that phase P5 implements it.
2. Do not explore, plan, generate, run or report anything on its behalf, and never present invented results as QA output.
3. Echo the arguments received: $ARGUMENTS
4. End with the line `QA-AGENT-SKILL: run | status=skeleton | phase=P5`.

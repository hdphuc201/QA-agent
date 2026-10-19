---
description: "QA Agent end-to-end pipeline (skeleton). Will chain discover, plan, generate, run and report with resume support. Not implemented yet."
argument-hint: "[scope]"
disable-model-invocation: true
---

# QA Agent — full-test (skeleton)

Status: **skeleton** — implementation is planned for phase P7 of `QA_AGENT_MASTER_ROADMAP.md`.

Planned behaviour: Orchestrate `discover → plan → generate → run → report` with recover/resume and an executive summary.

## When invoked now

1. Tell the user this skill is a skeleton and that phase P7 implements it.
2. Do not explore, plan, generate, run or report anything on its behalf, and never present invented results as QA output.
3. Echo the arguments received: $ARGUMENTS
4. End with the line `QA-AGENT-SKILL: full-test | status=skeleton | phase=P7`.

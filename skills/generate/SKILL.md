---
description: "QA Agent spec generation (skeleton). Will generate Playwright Test .spec.ts files from READY test cases. Not implemented yet."
argument-hint: "[test-plan-path]"
disable-model-invocation: true
---

# QA Agent — generate (skeleton)

Status: **skeleton** — implementation is planned for phase P4 of `QA_AGENT_MASTER_ROADMAP.md`.

Planned behaviour: Generate deterministic `.spec.ts` files and fixtures from `READY` test cases only, using role/label/test-id locators, writing only inside the output allowlist.

## When invoked now

1. Tell the user this skill is a skeleton and that phase P4 implements it.
2. Do not explore, plan, generate, run or report anything on its behalf, and never present invented results as QA output.
3. Echo the arguments received: $ARGUMENTS
4. End with the line `QA-AGENT-SKILL: generate | status=skeleton | phase=P4`.

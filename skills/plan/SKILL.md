---
description: "QA Agent test planning (skeleton). Will turn requirements and discovery observations into a traceable test matrix with NEEDS_REVIEW for unsupported expectations. Not implemented yet."
argument-hint: "[scope]"
disable-model-invocation: true
---

# QA Agent — plan (skeleton)

Status: **skeleton** — implementation is planned for phase P3 of `QA_AGENT_MASTER_ROADMAP.md`.

Planned behaviour: Map requirements from docs/code/observations, build a deduplicated test matrix (happy path, negative, boundary, RBAC, ...) with `requirementRefs`, and mark cases without evidence-backed expected results as `NEEDS_REVIEW`.

## When invoked now

1. Tell the user this skill is a skeleton and that phase P3 implements it.
2. Do not explore, plan, generate, run or report anything on its behalf, and never present invented results as QA output.
3. Echo the arguments received: $ARGUMENTS
4. End with the line `QA-AGENT-SKILL: plan | status=skeleton | phase=P3`.

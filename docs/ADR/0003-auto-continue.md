# ADR 0003 — Auto-continue orchestration for P2–P9

- Status: accepted
- Date: 2026-10-19
- Decided by: project owner (explicit request); recorded by Claude Code

## Context

Roadmap §0.4, §5 and §11 say each phase runs on its own prompt and Claude stops after the gate. The owner now wants P2–P9 to run back to back in one session, without confirmation between phases, while keeping every requirement and gate.

## Decision

- Auto-continue is enabled for P2–P9 (`docs/AUTOPILOT.md`). After a gate passes, Claude makes a local commit and starts the next phase.
- Unchanged: task IDs, acceptance criteria, gates, the progress CLI rules (evidence, phase ordering, gate preconditions), and the "do not fabricate" policy. The roadmap file itself is not edited, so the progress parser keeps working.
- Local commits are now allowed after a passed gate and a clean secret/personal-data scan. Push/publish/deploy still need the owner.
- Stop conditions: a blocker that survives 3 meaningful attempts, a required owner-terminal step (e.g. `smoke:claude`), or a forbidden action.

## Consequences

- Phases are still reviewed one at a time through `docs/PHASE_REVIEWS/Px.md` and per-phase commits, so the owner can audit or revert each phase.
- A long session risks context loss; the resume checkpoint in `docs/AUTOPILOT.md` plus `planning/progress.json` make each phase boundary a safe restart point.

## Addendum — 2026-10-19

The owner asked for every completed phase to be pushed and configured `origin` = `https://github.com/hdphuc201/QA-agent.git`. P0–P3 commits were pushed to `origin/main` (the remote was empty, so nothing was overwritten). From P4 on, each phase commit is pushed right after its gate passes and the staged files pass the secret/personal-data scan. Force-push, other branches, tags, releases and deployments still need explicit approval.

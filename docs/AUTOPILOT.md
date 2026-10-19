# Autopilot (auto-continue) policy

- Enabled: 2026-10-19 by the project owner, for phases **P2 → P9** (ADR 0003).
- Supersedes the "run one phase, then stop" rule of roadmap §0.4/§11 for this scope only. All task IDs, acceptance criteria and quality gates of the roadmap stay unchanged.

## Loop

1. `node scripts/progress.mjs check` and `summary` → the next phase whose gate is not `passed`.
2. Confirm the previous gate is `passed` (the CLI also enforces this on `start`).
3. Read every task and the gate of the phase in `QA_AGENT_MASTER_ROADMAP.md`.
4. For each task: `start` → implement + tests + docs → run checks → `complete --evidence` (or `block --reason`).
5. Phase gate: typecheck, lint, format:check, build, full `npm test` (regression of earlier phases), phase acceptance commands; logs in `evidence/<phase>/`; `docs/PHASE_REVIEWS/<phase>.md`; `progress check`; `gate <phase> passed`.
6. Secret/personal-data scan of staged files, then a local commit `feat: ... (<phase>)`.
7. Update the resume checkpoint below, then continue with the next phase immediately.

## Stop conditions (record with `block --reason` before stopping)

- The same blocker survives 3 meaningful fix attempts.
- A required check must run in the owner's terminal (e.g. `npm run smoke:claude`; Claude Code refuses nested sessions) or needs owner approval.
- The next step would require something forbidden below.

## Allowed without asking

Editing this repository; installing pinned dependencies after checking source and release age; local build/lint/typecheck/tests/smokes against local demo apps; progress/log/doc updates; local commits after a passed gate and a clean scan.

## Forbidden without explicit owner approval

Push, publish, release tags, deployment; production or third-party targets; unlicensed credentials; destructive operations outside test data; deleting/overwriting owner files outside this project; enabling paid services or extra usage; bypassing permissions, sandboxes or the nested-session guard.

## Resume checkpoint

Updated at every phase boundary. On a new session: restore from this section, `planning/progress.json`, `git log` and `git status`, not from chat memory.

- Last completed phase: P1 (gate passed, commit `0c99b13`)
- Current phase / task: P2 / P2-T01 (not started)
- Work in progress: none
- Files changed since last commit: autopilot policy (`CLAUDE.md`, this file, ADR 0003)
- Last test results: 52/52 tests, typecheck/lint/format/build/validate/progress check exit=0
- Open blockers: none
- Next action: start P2-T01 (project config schema)

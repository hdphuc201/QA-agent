# Autopilot (auto-continue) policy

- Enabled: 2026-10-19 by the project owner, for phases **P2 → P9** (ADR 0003).
- Supersedes the "run one phase, then stop" rule of roadmap §0.4/§11 for this scope only. All task IDs, acceptance criteria and quality gates of the roadmap stay unchanged.

## Loop

1. `node scripts/progress.mjs check` and `summary` → the next phase whose gate is not `passed`.
2. Confirm the previous gate is `passed` (the CLI also enforces this on `start`).
3. Read every task and the gate of the phase in `QA_AGENT_MASTER_ROADMAP.md`.
4. For each task: `start` → implement + tests + docs → run checks → `complete --evidence` (or `block --reason`).
5. Phase gate: typecheck, lint, format:check, build, full `npm test` (regression of earlier phases), phase acceptance commands; logs in `evidence/<phase>/`; `docs/PHASE_REVIEWS/<phase>.md`; `progress check`; `gate <phase> passed`.
6. Secret/personal-data scan of staged files, then a commit `feat: ... (<phase>)` and `git push origin main` (owner request, 2026-10-19).
7. Update the resume checkpoint below, then continue with the next phase immediately.

## Stop conditions (record with `block --reason` before stopping)

- The same blocker survives 3 meaningful fix attempts.
- A required check must run in the owner's terminal (e.g. `npm run smoke:claude`; Claude Code refuses nested sessions) or needs owner approval.
- The next step would require something forbidden below.

## Allowed without asking

Editing this repository; installing pinned dependencies after checking source and release age; local build/lint/typecheck/tests/smokes against local demo apps; progress/log/doc updates; local commits after a passed gate and a clean scan.

## Forbidden without explicit owner approval

Force-push, other remotes or branches, publish, release tags, deployment; production or third-party targets; unlicensed credentials; destructive operations outside test data; deleting/overwriting owner files outside this project; enabling paid services or extra usage; bypassing permissions, sandboxes or the nested-session guard.

## Resume checkpoint

Updated at every phase boundary. On a new session: restore from this section, `planning/progress.json`, `git log` and `git status`, not from chat memory.

- Last completed phase: P9 — CI/CD, packaging & v1.0 (gate passed; all phases P0–P9 passed; v1.0.0 release candidate on main, pushed; NOT tagged or published)
- Current phase / task: none — roadmap complete
- Work in progress: none
- Files changed since last commit: none expected after the P9 commit (`.serena/` stays untracked)
- Last test results: quality gate P9 all passed (unit+contract 157: 156 pass, 1 skipped; integration 16/16); CI run 39302621730 success; install smokes (local clone + GitHub) PASS; release dry-run OK
- Open blockers: none. Owner decisions: project license; optional `npm run smoke:claude-hook`; tag v1.0.0 / GitHub release only on explicit request
- Next action: none until the owner requests a release or new scope (propose scope changes as ADRs)

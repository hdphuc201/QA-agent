# QA Agent

A Claude Code plugin for hybrid QA (planned): Claude + Playwright MCP explore a web app, Playwright Test runs repeatable generated specs, and AI analyses the results.

**Current state: P0 (bootstrap & progress tracking).** The plugin, skills, MCP integration and test engine do not exist yet — they are built in phases P1–P9 of [`QA_AGENT_MASTER_ROADMAP.md`](QA_AGENT_MASTER_ROADMAP.md). Live progress: [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md).

## Requirements

- Node.js ≥ 22.12 (verified on v22.15.0) and npm (verified on 11.3.0)
- Git
- Claude Code CLI (needed from P1; verified 2.1.71)

## Setup

```powershell
npm install
npm run typecheck
npm run lint
npm run format:check
npm test
node scripts/progress.mjs check
```

## Progress tracking

`planning/progress.json` is the single source of truth. Only `scripts/progress.mjs` writes it; every valid update re-renders `docs/PROJECT_STATUS.md` (do not edit by hand) and appends to `docs/WORKLOG.md` (append-only).

```powershell
node scripts/progress.mjs init                         # idempotent; task IDs come from the roadmap
node scripts/progress.mjs start P0 P0-T01
node scripts/progress.mjs complete P0 P0-T01 --evidence "git status --short: exit=0"
node scripts/progress.mjs block P0 P0-T02 --reason "Node runtime unavailable"
node scripts/progress.mjs gate P0 passed --evidence "docs/PHASE_REVIEWS/P0.md"
node scripts/progress.mjs note P0 P0-T02 --message "decision ..."
node scripts/progress.mjs render
node scripts/progress.mjs check
node scripts/progress.mjs summary
```

Rules enforced by the CLI:

- Transitions: `not_started → in_progress → completed`; `not_started|in_progress → blocked`; `blocked → in_progress` (via `start`). `completed` is final.
- `complete` needs concrete evidence: an exit code (`exit=0`) or an existing file path inside the repo. Missing/out-of-repo paths are rejected.
- A task of phase Pn cannot start before the gate of P(n-1) passed.
- `gate Px passed` needs every task of Px completed, `docs/PHASE_REVIEWS/Px.md`, and a clean `check`.
- Writes are atomic (temp file + rename) under a lock file; corrupt state is reported (exit 3) and never overwritten.
- `--at <ISO>` imports a historical event with its original timestamp (tagged `imported` in the worklog).
- `--root <dir>` runs against another directory (used by tests with temp fixtures).

Exit codes: `0` ok, `1` validation/check failure, `2` usage error, `3` state/IO error.

## Repository layout (P0)

| Path                         | Purpose                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `QA_AGENT_MASTER_ROADMAP.md` | Scope, phases, task IDs, gates (stable)                         |
| `CLAUDE.md`                  | Rules every Claude Code session follows                         |
| `planning/progress.json`     | Progress state (CLI-managed)                                    |
| `scripts/progress.mjs`       | Progress CLI                                                    |
| `tests/unit/`                | Unit tests (Node test runner)                                   |
| `docs/`                      | Status (generated), worklog, ADRs, phase reviews, bootstrap log |
| `evidence/`                  | Command logs used as acceptance evidence                        |

Working with Claude Code: use the prompts in roadmap §0.4 to run one phase at a time or to resume.

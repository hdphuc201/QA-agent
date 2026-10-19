# QA Agent

A Claude Code plugin for hybrid QA (planned): Claude + Playwright MCP explore a web app, Playwright Test runs repeatable generated specs, and AI analyses the results.

**Current state: P1 (plugin foundation).** The plugin loads in Claude Code, its six skills are discoverable but are **skeletons**, and Playwright MCP is connected (localhost only). Discovery, planning, generation, execution and reporting are built in P2–P7 of [`QA_AGENT_MASTER_ROADMAP.md`](QA_AGENT_MASTER_ROADMAP.md). Live progress: [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md). Plugin usage and known limitations: [`docs/PLUGIN.md`](docs/PLUGIN.md).

## Requirements

- Node.js ≥ 22.12 (verified on v22.15.0) and npm (verified on 11.3.0)
- Git
- Claude Code CLI (verified 2.1.71)
- Google Chrome or another Playwright-supported browser for Playwright MCP (verified with installed Chrome)

## Setup

```powershell
npm install
npm run typecheck
npm run lint
npm run format:check
npm run build
npm test
node scripts/progress.mjs check
claude plugin validate .
npm run smoke:mcp       # Playwright MCP over JSON-RPC, no AI
```

## Use the plugin

```powershell
cd <target project>
claude --plugin-dir D:path	oQA-agent
# then: /qa-agent:discover --smoke http://localhost:3000/
```

`npm run smoke:claude` runs the same check non-interactively inside Claude Code and saves the transcript to `evidence/P1/` (costs ~0.11 USD; run it in a normal terminal, not inside a Claude Code session).

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

## Repository layout

| Path                         | Purpose                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `QA_AGENT_MASTER_ROADMAP.md` | Scope, phases, task IDs, gates (stable)                         |
| `CLAUDE.md`                  | Rules every Claude Code session follows                         |
| `.claude-plugin/plugin.json` | Plugin manifest                                                 |
| `skills/`                    | Six skills (skeletons in P1)                                    |
| `.mcp.json`                  | Playwright MCP server (pinned)                                  |
| `src/`                       | TypeScript engine (P1: path/config adapter)                     |
| `scripts/smoke/`             | Demo page and MCP/plugin smoke checks                           |
| `planning/progress.json`     | Progress state (CLI-managed)                                    |
| `scripts/progress.mjs`       | Progress CLI                                                    |
| `tests/`                     | Unit and contract tests (Node test runner)                      |
| `docs/`                      | Status (generated), worklog, ADRs, phase reviews, bootstrap log |
| `evidence/`                  | Command logs used as acceptance evidence                        |

Working with Claude Code: use the prompts in roadmap §0.4 to run one phase at a time or to resume.

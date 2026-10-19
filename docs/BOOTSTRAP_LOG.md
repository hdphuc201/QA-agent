# Bootstrap Log (P0-T01..P0-T04)

Temporary log used before `scripts/progress.mjs` exists (roadmap §3.4).
Entries are imported into `planning/progress.json` once the CLI works; this file is then kept as the original record.

## P0-T01 — Inspect environment and repository

- startedAt: 2026-10-19T04:45:02Z (from `date -u` in the audit shell)
- Commands (Git Bash / MINGW64 on Windows 11 Pro Education 10.0.26200):
  - `git --version` → exit=0, `git version 2.48.1.windows.1`
  - `node --version` → exit=0, `v22.15.0`
  - `npm --version` → exit=0, `11.3.0`
  - `claude --version` → exit=0, `2.1.71 (Claude Code)`
  - `pnpm --version` → exit=0, `10.18.3` (available, not used)
  - `yarn --version` → exit=0, `1.22.22` (available, not used)
  - `pwsh $PSVersionTable.PSVersion` → `7.6.7`
  - `npm config get registry` → `https://registry.npmjs.org/`
  - `git log` → branch `main`, no commits yet
  - `git status --short` → `?? .serena/`, `?? QA_AGENT_MASTER_ROADMAP.md`
- Pre-existing files (preserved, not modified): `QA_AGENT_MASTER_ROADMAP.md`, `.serena/` (Serena tool config), `.code-review-graph/` (code-review-graph tool DB, self-ignored).
- Package manager decision: npm (matches roadmap commands; lockfile `package-lock.json`).
- Missing prerequisites: none.
- Outcome: completed.

## P0-T02 — package.json, TypeScript strict, scripts, .gitignore, .editorconfig

- startedAt: 2026-10-19T04:48:09Z
- Files: `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `.editorconfig`.
- Dependency versions pinned exactly, each released ≥ 2 weeks before 2026-10-19 (checked with `npm view <pkg> time`).
- First `npm install` (with vitest@5.0.3) → exit=1, `npm error Cannot read properties of null (reading 'edgesOut')` (npm 11.3.0 arborist `#loadPeerSet` bug). Bisected in a temp dir: only `vitest` (4.x and 5.x) triggers it; `--legacy-peer-deps` would skip the required `vite` peer.
- Decision (see `docs/ADR/0001-tooling.md`): use the Node built-in test runner (`node --test --experimental-strip-types`) instead of Vitest. Removed vitest + vitest.config.ts.
- `npm install --no-fund --no-audit` → exit=0, "added 100 packages" (log: `evidence/P0/npm-install.log`).
- `npx tsc --version` → `Version 6.0.3`; `npx eslint --version` → `v10.12.0`; `npx prettier --version` → `3.9.9`.
- Scripts: `typecheck`, `lint`, `format:check`, `format`, `test`, `progress`. No `build` script: there is no TypeScript source to compile yet (the CLI is plain `.mjs`, type-checked via `checkJs`). A `build` script will be added when `src/` exists.
- completedAt: 2026-10-19T04:52:53Z
- Outcome: completed (lint/typecheck/test executed against real files in P0-T07).

## P0-T03 — Seed planning/progress.json with P0–P9 task inventory

- startedAt: 2026-10-19T04:53:06Z
- Method: one-off `node -e` script parsed `### Px — <title>` headings and `- [ ] **Px-Tyy** — <title>` lines from `QA_AGENT_MASTER_ROADMAP.md` (read-only) and wrote `planning/progress.json` (schemaVersion 1, all statuses `not_started`, all gates `pending`). No task was marked as done.
- Result: 10 phases, 62 tasks (P0:7, P1:6, P2:6, P3:6, P4:6, P5:6, P6:6, P7:6, P8:7, P9:6).
- Cross-check: `grep -c '\*\*P[0-9]-T[0-9][0-9]\*\* —' QA_AGENT_MASTER_ROADMAP.md` → `62`, exit=0.
- completedAt: 2026-10-19T04:53:17Z
- Outcome: completed.

## P0-T04 — progress CLI (bootstrap ends)

- startedAt: 2026-10-19T04:53:27Z
- `node scripts/progress.mjs init` on the T03 seed → exit=0, "0 missing task(s) added", sha256 of `planning/progress.json` unchanged (idempotent).

## Import into the standard workflow

- P0-T01..P0-T03 (start + complete) and P0-T04 (start) were replayed through `node scripts/progress.mjs ... --at <original timestamp>` using the times recorded above; `docs/WORKLOG.md` tags them `imported`.
- From P0-T04 onward every transition is recorded directly by the CLI. This file is kept unchanged above this section as the original record.

# QA Agent — Engineering Rules

Source of truth: `QA_AGENT_MASTER_ROADMAP.md` (scope, task IDs, gates) and `planning/progress.json` (state).

## Session start

1. Read `QA_AGENT_MASTER_ROADMAP.md`, `planning/progress.json`, `docs/PROJECT_STATUS.md` and the end of `docs/WORKLOG.md`.
2. Run `git status` / `git diff` and `node scripts/progress.mjs check`. If check fails, fix state consistency before any feature work.
3. Resume the first `in_progress`/`blocked` task of the phase the user requested. Trust files, not chat memory.

## Rules

- Execute only the phase explicitly requested by the user. Stop after it.
- Track every task with `node scripts/progress.mjs`; never edit `planning/progress.json` or `docs/PROJECT_STATUS.md` by hand (exception: fixing a CLI bug, logged in WORKLOG).
- Before task: `start`. After verified completion: `complete --evidence "<command>: exit=<n>"` or an existing file path.
- On blockers: `block --reason "<what + how to unblock>"`; do not fabricate success.
- Record significant technical decisions with `note <phase> [task] --message` (and an ADR in `docs/ADR/` when architectural).
- Before saying a phase is done: run acceptance commands, save logs under `evidence/<phase>/`, write `docs/PHASE_REVIEWS/Px.md` (template in roadmap §6), run `progress check`, then `gate Px passed --evidence docs/PHASE_REVIEWS/Px.md`.
- Report changes, executed tests, failures, risks and the next-phase prompt; then stop.
- Never change production/business code or protected project docs (e.g. CHUNJI) to make tests pass.
- No secrets in Git or reports. No production/destructive tests without explicit approval.
- Use TypeScript strict; prefer small, tested modules; no unnecessary dependencies.
- Keep `QA_AGENT_MASTER_ROADMAP.md` stable; propose scope change as ADR, not by silently removing requirements.
- No git commit, push, deployment, or package publish without explicit user permission.

## Commands

```text
npm run typecheck · npm run lint · npm run format:check · npm run build · npm test
claude plugin validate . · npm run smoke:mcp · npm run smoke:claude (normal terminal only; never bypass the nested-session guard)
node scripts/progress.mjs init | start Px Px-Tyy | complete Px Px-Tyy --evidence "..." | block Px Px-Tyy --reason "..."
node scripts/progress.mjs gate Px passed --evidence docs/PHASE_REVIEWS/Px.md | render | check | summary
```

Exit codes: 0 ok · 1 validation/check failure · 2 usage · 3 state/IO (corrupt, locked, missing).
Tests use the Node built-in runner (`node --test`, TypeScript via type stripping) — see `docs/ADR/0001-tooling.md`.

# ADR 0004 — Discovery engine, sample app and runtime conventions

- Status: accepted
- Date: 2026-10-19
- Phase: P2

## Decisions

1. **Sample app built in P2, not P6.** P2's gate needs a demo app to discover. `examples/sample-app/` (node:http, no dependencies, 127.0.0.1 only, in-memory data) already has the P6-T01 shape: three roles (requester, approver, viewer), an approval workflow, seed data, a test-mode reset endpoint and an opt-in intentional defect (`SAMPLE_APP_BUG=skip-approve-rbac`). P6-T01 reuses it rather than building a second app. Its requirements (`docs/requirements.md`) are fixture data, not CHUNJI requirements.
2. **Deterministic engine + thin skills.** `src/cli.ts` runs every stage. Skills call it with `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" <stage>` and summarise its output. Runs are reproducible without AI, and AI never decides PASS/FAIL.
3. **Zod 4.6.5 is the first runtime dependency** (schemas for config and artifacts; JSON Schema is generated from it). A plugin loaded with `--plugin-dir` uses the repo's `node_modules`. Shipping the plugin without a local install is a P9 packaging concern.
4. **Discovery talks to Playwright MCP directly** (`src/discovery/mcp-client.ts`, JSON-RPC over stdio), starting the server from the plugin's `.mcp.json`. Two per-project overrides apply: `--allowed-origins` comes from the project config and `--output-dir` is `qa-artifacts/playwright-mcp`.
5. **Exploration is read-mostly.** The tools are `browser_navigate`, `browser_snapshot` and `browser_close`. `browser_fill_form` and `browser_click` are allowed only inside the configured login recipe. GET paths that look state-changing (`logout`, `delete`, `reset`, ...) are never opened. URLs are checked before and after navigation (redirects).
6. **Account references.** Config holds `accountKey` only. Credentials come from `QA_AGENT_ACCOUNT_<KEY>_USERNAME/_PASSWORD`, and values are masked in every stored output. Config keys that look like credentials are rejected.
7. **Writes** go only to `.qa-agent/`, `<testOutputRoot>` and `qa-artifacts/` of the target project, never into `readOnlyPaths` (`src/config/write-guard.ts`).
8. **Live tests run by default** (`tests/integration/*`). Set `QA_AGENT_SKIP_LIVE=1` to skip them; they are then reported as skipped.

## Consequences

- Node ≥ 22.12 is required to run the engine from source (type stripping). A built `dist/` is available through `npm run build`.
- Static extraction is heuristic: regex and markup patterns, with confidence values. Unknown frameworks yield fewer routes, and live observation fills the gaps.

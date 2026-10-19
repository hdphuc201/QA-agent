# ADR 0008 — Packaging: bundled engine, marketplace manifest, CI

- Status: accepted
- Date: 2026-10-20
- Phase: P9

## Context

The install tests (P9-T03) showed the following:

- A plugin installed from a marketplace is a copy of the repository without `node_modules`. A GitHub source is a clone of the tracked files.
- A **local-path** marketplace copies the whole working directory, local artifacts and `node_modules` included.
- The skills ran `node --experimental-strip-types src/cli.ts`, which imports `zod`. Generated-code validation ran `typescript` from the plugin's `node_modules`, and generated specs were formatted with the plugin's `prettier`. An installed plugin therefore could not run its engine.

## Decisions

1. **The engine ships as a committed bundle.** `bin/qa-agent.mjs` is built from `src/cli.ts` by esbuild 0.28.1 (dev dependency, exact pin) with `npm run bundle`, and has zod inlined. It is self-contained: only `node:` built-ins and the optional formatter stay external, which the contract test enforces. Skills call `node "${CLAUDE_PLUGIN_ROOT}/bin/qa-agent.mjs"`, so type stripping is no longer needed at run time. CI fails when the bundle is stale (`npm run bundle:check`).
2. **The plugin version is read from the plugin manifest**, found by walking up from the module (works from `src/` and from `bin/`).
3. **Strict type-check of generated code uses the target project's TypeScript first**, then the plugin checkout's. Without TypeScript the result says `typecheck: NOT RUN` (full-test: "type-check not run (no TypeScript)"); it never says ok. Playwright's `--list`, which compiles every file, still runs. `@types/node` comes from the target project, else from the plugin checkout.
4. **Prettier is optional at run time.** The engine uses the plugin checkout's Prettier, else the target project's, else leaves output unformatted (already reported as a note). The 4.5 MB formatter is not bundled.
5. **Marketplace manifest** `.claude-plugin/marketplace.json` (single plugin, `source: "./"`) for `claude plugin marketplace add <path | owner/repo>`. Marketplace and manifest versions must match (contract test).
6. **Install tests run with an isolated `CLAUDE_CONFIG_DIR`**, so the owner's Claude configuration is never touched. Local installs come from a fresh `git clone` of the commit, never the working directory, which is how a GitHub install behaves and avoids copying local artifacts.
7. **CI** (`.github/workflows/ci.yml`, GitHub-hosted runners, public repository, no secrets) has two jobs:
   - **Static and unit/contract:** checks, unit/contract tests and plugin validation on Linux and Windows.
   - **Live integration (Linux):** Playwright browser cache, Chromium/Firefox/WebKit install, MCP warm-up, serial integration tests, the vertical slice, a JUnit failure summary, and artifacts kept 14 days.

## Consequences

- A change in `src/` needs `npm run bundle` before commit. CI and the contract test catch a forgotten rebuild.
- The bundle is about 0.9 MB of readable JavaScript in the repository.
- No license is declared yet (`package.json` is private, no LICENSE file). This is an owner decision, listed in the release checklist.

# ADR 0001 — P0 tooling choices

- Status: accepted
- Date: 2026-10-19
- Phase: P0 (P0-T02, P0-T04)

## Context

The roadmap (§2.1) asks for TypeScript strict, one unit-test tool (Vitest **or** the Node test runner), a lint/format pair and JSON-based persistence, without unnecessary dependencies. Environment (P0-T01): Windows 11, Node v22.15.0, npm 11.3.0.

## Decisions

1. **Package manager: npm** with exact pinned versions and `package-lock.json`. Every pinned version was released at least two weeks before 2026-10-19.
2. **Unit tests: Node built-in test runner** (`node --test --experimental-strip-types`), tests written in TypeScript.
   - `npm install` of `vitest@5.0.3` (and `vitest@4`) fails on npm 11.3.0 with `Cannot read properties of null (reading 'edgesOut')` (arborist `#loadPeerSet` bug); `--legacy-peer-deps` would skip vitest's required `vite` peer. Upgrading the global npm was out of scope (no global installs).
   - `node:test` needs no dependency and is available on every supported Node.
   - `tsconfig.json` sets `erasableSyntaxOnly` so test files only use syntax that Node can strip.
   - Revisit if a future phase needs features (snapshot/golden-file helpers, browser mode) that `node:test` lacks.
3. **TypeScript 6.0.3** (not 7.x): `typescript-eslint@8.71.0` supports `typescript >=4.8.4 <6.1.0`.
4. **Lint/format: ESLint 10 + typescript-eslint (strict) + Prettier 3.**
5. **Progress CLI is plain `scripts/progress.mjs`** (as the roadmap names it), type-checked by `tsc` through `allowJs` + `checkJs` + JSDoc types. It uses only Node built-ins, so it runs before `npm install`. Validation is hand-written (no Zod) for the same reason.
6. **Task inventory comes from the roadmap.** `init` and `check` parse `### Px — Title` and `- [ ] **Px-Tyy** — Title` lines from `QA_AGENT_MASTER_ROADMAP.md`, so the list of task IDs is never duplicated by hand.
7. **No `build` script yet**: there is no TypeScript source to compile in P0. It is added when `src/` exists (P1+).

## Consequences

- Node 22 flags type stripping as experimental; `npm test` suppresses that warning with `--disable-warning=ExperimentalWarning`. Test files must avoid non-erasable TS syntax (enums, namespaces, parameter properties).
- Contributors on newer npm can still use Vitest later, but switching requires a new ADR (one test tool only).

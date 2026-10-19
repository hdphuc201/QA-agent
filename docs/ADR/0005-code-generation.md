# ADR 0005 — Playwright code generation

- Status: accepted
- Date: 2026-10-19
- Phase: P4

## Decisions

1. **Self-contained output.** `<testOutputRoot>/` gets `qa-agent.fixtures.ts`, a copy of the type-checked runtime `src/generator/runtime/qa-agent.fixtures.ts` with only the config block replaced. It also gets one spec per feature, `playwright.qa-agent.config.ts`, optional global setup/teardown, `case-map.json` and `.qa-agent-manifest.json`. The target project needs `@playwright/test`, but not QA Agent sources.
2. **1:1 mapping.** Every structured assertion of a READY case becomes exactly one `expect*` call (tested). Locators are `getByRole` / `getByLabel` / `getByText` with exact names; no CSS/XPath. Each expectation is a `test.step` titled with the requirement sentence and file:line.
3. **Deterministic formatting** with fixed Prettier options (independent of the target's Prettier config). Prettier is resolved from the plugin; if missing, output is still written and marked unformatted.
4. **Idempotency via manifest hashes.** An unchanged file is not rewritten. A generated file the user edited, or a file without the generated header, is never overwritten: the new version goes to `*.qa-agent-new`. A stale generated file is removed only if unmodified.
5. **Output location rules.** Writes go through the write guard. The schema rejects a `testOutputRoot` that overlaps `sourcePaths` or `readOnlyPaths`, in either direction. Without this, the output root alone could make application source writable.
6. **Validation** = strict `tsc` over the generated files (plugin's TypeScript) + `playwright test --list` with the **target project's** `@playwright/test`. Only tests whose title carries a case ID from the case map are counted, so custom specs may live alongside. A missing `@playwright/test` is reported as BLOCKED.
7. **Test data lifecycle.** The optional `testData.resetPath` (POST) runs in globalSetup/globalTeardown. It is refused for `environment: production`, and at runtime when the base URL origin is not in `allowedOrigins` (e.g. a stray `QA_AGENT_BASE_URL`).
8. **Credentials** only via `QA_AGENT_ACCOUNT_<KEY>_*` at run time. A missing variable throws `QA_AGENT_BLOCKED: …`, which reporting (P7) classifies as BLOCKED rather than FAIL.
9. **Browser.** The default project is Playwright's Chromium. `QA_AGENT_BROWSER_CHANNEL=chrome` uses an installed Chrome; this machine's evidence runs use it. CI browser installation is P9.

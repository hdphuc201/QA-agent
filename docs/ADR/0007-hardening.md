# ADR 0007 — Hardening: execution-layer policies, artifact scrubbing, portability, browsers, hooks

- Status: accepted
- Date: 2026-10-20
- Phase: P8

## Decisions

1. **Policies are enforced where tests run, not only in planning.** The generated runtime routes every request of every role context through a guard. Requests to an origin outside `allowedOrigins` are aborted (`blockedbyclient`) and recorded as `qa-blocked` annotations. `qa-agent run`, live `discover` and `full-test` refuse `environment: "production"` unless `QA_AGENT_ALLOW_PRODUCTION=1` (owner approval). Destructive steps (Delete/Remove/… buttons, HTTP DELETE) make a case BLOCKED unless `policy.allowDestructive` is set. Threat model: `docs/THREAT_MODEL.md`.
2. **Artifacts are scrubbed after every run phase.** Playwright traces and HTML reports record typed values verbatim, passwords included. `src/evidence/scrub.ts` rewrites traces (zip, including nested zips), base64 zips embedded in HTML reports, and text artifacts, replacing the raw, URL-encoded and JSON-escaped forms of every `QA_AGENT_ACCOUNT_*_PASSWORD` value with `***`. It uses a small zip reader/writer on `node:zlib` (no new dependency); ZIP64 archives are rejected and reported, not silently kept. Screenshots/videos are out of scope (pixels).
3. **Second target app instead of a per-app adapter layer.** `examples/helpdesk-app` differs in routing style, routes, labels, roles, wording and output folder. Running it end to end found two engine defects (a hardcoded `data.title` in "appears on", duplicated blocker messages), which were fixed in the engine. No app-specific adapter code was needed: everything app-specific stays in `.qa-agent/config.json` and the requirement documents.
4. **Browsers are a config list** (`browsers`, default `["chromium"]`), one Playwright project each. A case reports its **worst** browser (FAIL > BLOCKED > NOT_RUN > SKIPPED > PASS) and lists every browser (`byBrowser`), so a pass in one engine never hides a failure in another. Session cache files are kept per engine.
5. **Hooks: a PreToolUse credential guard instead of SessionStart/Stop hooks.** The roadmap allowed optional SessionStart/Stop hooks after the upstream API was checked. The risk actually observed (P7 owner smoke: Claude echoed password variables) is addressed by `hooks/hooks.json` → `hooks/guard-credentials.mjs`. It denies Bash/PowerShell commands that expand, read, print or embed `QA_AGENT_ACCOUNT_*_PASSWORD`, or dump the whole environment. The protocol (`hookSpecificOutput.permissionDecision: "deny"`, `${CLAUDE_PLUGIN_ROOT}`, `hooks/hooks.json`) was checked against the installed Claude Code 2.1.71. No SessionStart/Stop hook was added, because no verified need exists, and hooks must never change test status. Live in-session proof is an owner-terminal smoke (`npm run smoke:claude-hook`) because nested Claude sessions are refused.
6. **Integration tests run one file at a time** (`npm run test:integration`, `--test-concurrency=1`); unit/contract tests stay parallel. With 5+ browser-heavy files running at once on one machine, the first test of a worker could time out on `page.goto` (seen once in the P8 gate). Serial files remove that resource contention without retries or longer timeouts.

## Consequences

- Traces stay usable (same structure, masked values). A secret shorter than 3 characters is not scrubbed (too many false matches).
- Cross-browser runs need `npx playwright install firefox webkit`; CI must install them (P9).
- The hook guards only shell tools; reading a `.env` file with the Read tool is not covered (credentials are not expected in files: `docs/CONFIG_GUIDE.md`).

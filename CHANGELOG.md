# Changelog

All notable changes of the QA Agent plugin. Versions follow [Semantic Versioning](https://semver.org/). Phase reviews with the evidence for each item are in [`docs/PHASE_REVIEWS/`](docs/PHASE_REVIEWS/).

## 1.0.0 — release candidate (not tagged or published)

First complete version: roadmap phases P0–P9.

### Plugin

- Six user-invoked skills: `/qa-agent:discover`, `plan`, `generate`, `run`, `report` and `full-test` (`--offline`, `--resume`).
- `failure-analyzer` agent: read-only second opinion on failures; it never changes a verdict.
- Playwright MCP (`@playwright/mcp@0.0.83`): headless, isolated, origin-restricted.
- PreToolUse credential guard hook.
- Self-contained engine bundle `bin/qa-agent.mjs`: an installed plugin needs no `npm install`.
- Single-plugin marketplace manifest: `claude plugin marketplace add hdphuc201/QA-agent`.

### Engine

- **Discovery:** static map of routes, forms, UI and roles with provenance and source lines, plus live exploration through MCP. Exploration stays within `allowedOrigins`, never opens state-changing GETs, and signs in through a login recipe.
- **Planning:** controlled requirement language turned into a deterministic plan:
  - covers boundaries, RBAC/negative API splits, subject dependencies and second tabs;
  - unclear requirements become `NEEDS_REVIEW` and are never run;
  - exported as JSON, Markdown and CSV.
- **Generation:** readable Playwright Test specs with a runtime that provides:
  - one browser context per role, extra tabs, and credentials from the environment;
  - an opt-in session cache with controlled refresh;
  - test-data reset and an execution-layer origin guard.

  Drift detection never overwrites edited files. Output is validated with a strict type-check (when TypeScript is available) and `playwright --list`.

- **Runs:** an isolation analysis splits cases into a parallel phase and a serial phase. Run records, input snapshots and metadata are kept, and credential values are scrubbed from traces, reports and text artifacts.
- **Reporting:**
  - statuses PASS / FAIL / SKIPPED / BLOCKED / NOT_RUN;
  - rule-based failure classification and requirement coverage;
  - HTML, Markdown and JSON reports;
  - a worst-browser verdict across Chromium, Firefox and WebKit.
- **full-test:** resumable pipeline. It succeeds only when every READY case reached a verdict without failures.
- **Policies:** production refused without `QA_AGENT_ALLOW_PRODUCTION=1`; destructive steps BLOCKED unless `policy.allowDestructive`; no credentials in config, command lines or artifacts.

### Quality

- Unit, contract and live integration suites (two example apps, security, cross-browser).
- CI on GitHub Actions (Linux + Windows checks, Linux live integration with Chromium, Firefox and WebKit).
- Benchmark baseline, threat model, ADRs 0001–0008.

### Known limitations

See [`docs/FINAL_PROJECT_REPORT.md`](docs/FINAL_PROJECT_REPORT.md#limitations).

## 0.1.0 — development

Phases P0–P8 on `main` (bootstrap, plugin foundation, discovery, planning, generation, sessions, vertical slice, reporting, hardening).

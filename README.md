# QA Agent

A Claude Code plugin for hybrid web QA:

1. **discover** — read the target project's config, docs and source (read-only) and explore the running app with Playwright MCP inside an origin allowlist;
2. **plan** — turn requirement documents into a traceable, risk-ranked test matrix (READY / NEEDS_REVIEW / BLOCKED);
3. **generate** — emit Playwright Test specs (role/label locators, one assertion per expected result);
4. **run** — execute them with one browser context per role, isolated cases in parallel, shared-state cases serially;
5. **report** — normalised results, failure classification with evidence, requirement coverage (Markdown, JSON, HTML).

Every stage is a deterministic CLI (`src/cli.ts`). The Claude Code skills (`/qa-agent:<stage>`) call it and summarise its output. PASS/FAIL always comes from Playwright assertions, never from AI.

**Status:** MVP (roadmap phases P0–P7). Hardening (P8) and packaging/CI (P9) are not done yet. Progress: [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) · plan: [`QA_AGENT_MASTER_ROADMAP.md`](QA_AGENT_MASTER_ROADMAP.md) · reviews: [`docs/PHASE_REVIEWS/`](docs/PHASE_REVIEWS/).

## Requirements

- Node.js ≥ 22.12 (verified v22.15.0) and npm (verified 11.3.0), Git
- A Chromium-based browser for Playwright: the installed Google Chrome (`QA_AGENT_BROWSER_CHANNEL=chrome`, used for all evidence here) or `npx playwright install chromium`
- Claude Code CLI for the plugin (verified 2.1.71)
- Network access on first use (npm registry for the pinned `@playwright/mcp`)

## Getting started (about 5 minutes)

```powershell
git clone https://github.com/hdphuc201/QA-agent.git
cd QA-agent
npm ci
node scripts/quality-gate.mjs P7 --skip-live   # typecheck, lint, format, build, tests (no browser)
npm run smoke:mcp                               # Playwright MCP connectivity (opens headless Chrome)
node scripts/smoke/vertical-slice.mjs           # the whole pipeline on the bundled sample app
```

The vertical slice copies `examples/sample-app` to a temp folder and starts the app from its seed data. It then runs `discover → plan → generate → run → report` and prints a JSON summary (`"ok": true`, 20/20 passed). Add `--bug skip-approve-rbac` to switch on an intentional authorization defect: exactly the two API authorization cases fail and are classified as `probable_app_bug`. Add `--out evidence/x` to keep the artifacts.

Step by step: [`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md).

## Use it from Claude Code

```powershell
cd <your target project>
claude --plugin-dir D:\path\to\QA-agent
```

Then: `/qa-agent:discover`, `/qa-agent:plan`, `/qa-agent:generate`, `/qa-agent:run`, `/qa-agent:report`, or everything at once with `/qa-agent:full-test [--offline] [--resume]`. The skills only run when you invoke them. `/qa-agent:report` can ask the read-only `failure-analyzer` agent for a second opinion on failures; that opinion is shown next to the rule-based one and never changes a result.

Without Claude, use the same stages directly:

```powershell
node --experimental-strip-types D:\path\to\QA-agent\src\cli.ts full-test --project .
```

## Use it on your project

1. Add `.qa-agent/config.json` (guide: [`docs/CONFIG_GUIDE.md`](docs/CONFIG_GUIDE.md)).
2. Write requirements in the controlled format the planner understands ([`docs/REQUIREMENTS_FORMAT.md`](docs/REQUIREMENTS_FORMAT.md)). A requirement without measurable `Expected` lines produces a `NEEDS_REVIEW` case; such cases are never run.
3. Install `@playwright/test` and `@types/node` in the target project.
4. Provide credentials per role in your environment, never in files: `QA_AGENT_ACCOUNT_<ACCOUNT_KEY>_USERNAME` and `_PASSWORD` (e.g. `demo.requester` → `QA_AGENT_ACCOUNT_DEMO_REQUESTER_*`).
5. Run `full-test` against a **local or staging** environment.

## Where the outputs go (target project)

| Path                                           | Content                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.qa-agent/discovery/`                         | `project-map.json` (routes, forms, UI, roles with provenance and `observedIn` links), `observations.json`                                                                                               |
| `.qa-agent/plan/`                              | `test-plan.json` (versioned), `test-plan.md`, `test-cases.csv`                                                                                                                                          |
| `<testOutputRoot>/` (default `e2e/generated/`) | specs, `qa-agent.fixtures.ts`, `playwright.qa-agent.config.ts`, `case-map.json`, manifest                                                                                                               |
| `qa-artifacts/runs/<runId>/`                   | `run.json`, `schedule.json`, `inputs/` (frozen stage outputs + `versions.json`), `results-*.json`, `html-*/`, `test-results-*/` (traces, screenshots), `report/{results.json, summary.md, report.html}` |
| `.qa-agent/full-test-state.json`               | resumable pipeline state                                                                                                                                                                                |

Writes outside `.qa-agent/`, `<testOutputRoot>/` and `qa-artifacts/`, or into `readOnlyPaths`, are refused. **Keep `qa-artifacts/` out of Git:** traces and screenshots can contain session data and typed values.

## Safety rules (enforced, not just documented)

- Browser exploration only inside `allowedOrigins`, checked before and after navigation. Playwright MCP's own `--allowed-origins` is a second layer, not a security boundary. Exploration never opens state-changing GETs and only fills/clicks the login form.
- No credentials in config (rejected) or outputs (masked); session caches are opt-in and purged after runs.
- The data reset endpoint (`testData.resetPath`) is refused for `environment: production` and for base URLs outside the allowlist.
- Generated tests can only reach `allowedOrigins`: the runtime aborts every other request (navigation, fetch, assets) and reports it.
- `run`, live `discover` and `full-test` refuse `environment: production` unless the owner sets `QA_AGENT_ALLOW_PRODUCTION=1`. Destructive steps (Delete/Remove/… buttons, HTTP DELETE) make a case BLOCKED unless `policy.allowDestructive` is set.
- Traces, HTML/JSON reports and other run artifacts are scrubbed of credential values after every run phase.
- The plugin hook refuses shell commands that would print `QA_AGENT_ACCOUNT_*_PASSWORD` values or dump the environment.
- Generated specs and plans are never edited to make results pass; edited generated files are not overwritten.

Threat model: [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## Development

```powershell
npm run typecheck · npm run lint · npm run format:check · npm run build · npm test
node scripts/quality-gate.mjs <phase>     # all checks, logs in evidence/<phase>/
node scripts/progress.mjs summary         # roadmap progress (see CLAUDE.md for the workflow)
npm run bench                             # runtime/memory/flakiness baseline, evidence/P8/benchmark.md
```

Tests use the Node test runner with TypeScript type stripping. Live tests (real browser, Playwright MCP) run by default; `QA_AGENT_SKIP_LIVE=1` skips them and they are reported as skipped. The architecture decisions are in [`docs/ADR/`](docs/ADR/). Plugin details and known limitations: [`docs/PLUGIN.md`](docs/PLUGIN.md).

| Path                                                                                                                                       | Purpose                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `.claude-plugin/plugin.json`, `skills/`, `agents/`, `hooks/`, `.mcp.json`                                                                  | Claude Code plugin                                                                                                      |
| `src/config` · `src/discovery` · `src/planning` · `src/generator` · `src/orchestrator` · `src/reporting` · `src/sessions` · `src/evidence` | engine stages                                                                                                           |
| `examples/sample-app/`, `examples/helpdesk-app/`                                                                                           | two demo target apps with different routing, labels, roles and output folders (fixture requirements, not real products) |
| `scripts/progress.mjs` · `scripts/quality-gate.mjs` · `scripts/smoke/`                                                                     | progress CLI, gate runner, smokes and the vertical slice                                                                |
| `tests/`                                                                                                                                   | unit, contract, integration tests; golden generated files                                                               |
| `planning/`, `docs/`, `evidence/`                                                                                                          | progress state, docs (status, worklog, ADRs, reviews), acceptance evidence                                              |

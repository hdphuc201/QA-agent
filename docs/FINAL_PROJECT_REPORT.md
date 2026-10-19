# QA Agent — Final project report (v1.0.0)

- Date: 2026-10-20
- Scope: roadmap phases P0–P9 (`QA_AGENT_MASTER_ROADMAP.md`), all implemented in auto-continue mode (ADR 0003)
- Repository: https://github.com/hdphuc201/QA-agent (public), branch `main`
- Version: 1.0.0, release candidate. **Not tagged, not published.** Tagging and publishing wait for the owner's explicit request ([`RELEASE.md`](RELEASE.md)).

## 1. What QA Agent is

QA Agent is a Claude Code plugin for end-to-end QA of web applications. It follows a hybrid model:

- **Exploration** of the running app with Playwright MCP, restricted to allowed origins.
- **Deterministic planning and generation:** requirement documents are turned into a test plan and into readable, repeatable Playwright Test specs.
- **Execution** with real roles, sessions and tabs.
- **Analysis** of the results, with evidence and requirement coverage.

PASS/FAIL always comes from Playwright assertions. AI is used only where judgment helps: the Claude session drives the stages, and a read-only agent gives a second opinion on failures that never changes a verdict.

## 2. Architecture

```
Claude Code session
  └─ plugin qa-agent (skills, agent, hook, .mcp.json)
       ├─ /qa-agent:<stage> skills ──► node bin/qa-agent.mjs <stage>   (deterministic engine, bundled)
       ├─ failure-analyzer agent (Read/Grep/Glob only) ──► ai-analysis.json
       ├─ PreToolUse hook: credential guard for Bash/PowerShell
       └─ Playwright MCP 0.0.83 (headless, isolated, origin-restricted)

engine (src/, bundled to bin/qa-agent.mjs)
  config ─► discovery ─► planning ─► generator ─► orchestrator ─► reporting
  (schema,   (static map   (controlled   (specs +      (isolation,     (normalise,
   policy,    + MCP         language →    runtime,      scheduler,      classify,
   paths)     exploration)  test plan)    validation)   run, scrub)     coverage, report)

target project
  .qa-agent/config.json, docs/*.md  ─► .qa-agent/{discovery,plan}/, <testOutputRoot>/*.spec.ts,
                                       qa-artifacts/runs/<runId>/{results, traces, report}
```

Each stage is a CLI command with explicit inputs and outputs in the target project. `full-test` chains the stages and can resume. Decisions and their reasons are recorded in [`docs/ADR/0001–0008`](ADR/).

## 3. Features

| Area           | Delivered                                                                                                                                                                                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plugin**     | 6 user-invoked skills: `discover`, `plan`, `generate`, `run`, `report`, `full-test`; read-only `failure-analyzer` agent; Playwright MCP; credential guard hook; marketplace manifest; self-contained engine bundle                                                                                                                            |
| **Discovery**  | Routes, forms, UI and roles from docs and source, with provenance and file:line. Live exploration via MCP: URL guard before and after every navigation, no state-changing GETs, sign-in via the configured recipe, retries, observations linked to the map                                                                                    |
| **Planning**   | Controlled requirement language ([`REQUIREMENTS_FORMAT.md`](REQUIREMENTS_FORMAT.md)): boundary values, RBAC and negative API splits, subjects with dependencies, second-tab checks. Unclear requirements become NEEDS_REVIEW and are never run; destructive steps are BLOCKED by policy. Output as JSON, Markdown and CSV                     |
| **Generation** | Readable specs grouped by feature, plus a runtime with one context per role, extra tabs, credentials from the environment, an opt-in session cache with controlled refresh, test-data reset and an origin guard. Drift detection never overwrites edited files. Validation: strict tsc (when TypeScript is available) and `playwright --list` |
| **Execution**  | Isolation analysis (parallel vs `@serial`), worker budget, run records with metadata and input snapshots, artifact scrubbing, session purge                                                                                                                                                                                                   |
| **Reporting**  | PASS/FAIL/SKIPPED/BLOCKED/NOT_RUN; flakiness; rule-based classification (probable app bug, test automation issue, environment, insufficient evidence) with evidence; requirement coverage; HTML, Markdown and JSON                                                                                                                            |
| **Browsers**   | Chromium (or the Chrome channel), Firefox and WebKit as projects; a case reports its worst browser                                                                                                                                                                                                                                            |
| **Safety**     | Production refused without owner approval; allowed-origin confinement at exploration and run time; no credentials in config, command lines, artifacts or reports; read-only paths; write allowlist                                                                                                                                            |

## 4. Install and use

Full tutorial with two different projects: [`TUTORIAL.md`](TUTORIAL.md).

```powershell
claude plugin marketplace add hdphuc201/QA-agent
claude plugin install qa-agent@qa-agent
cd <target project>      # with .qa-agent/config.json, requirements in docs/, @playwright/test installed
claude                   # then: /qa-agent:full-test
```

Without Claude: `node <plugin dir>/bin/qa-agent.mjs full-test --project .`. Configuration: [`CONFIG_GUIDE.md`](CONFIG_GUIDE.md). Credentials come from `QA_AGENT_ACCOUNT_<KEY>_USERNAME/_PASSWORD` in the environment.

## 5. Tests and quality gates

| Suite                                           | Content                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (`tests/unit`, 20 files)                   | progress CLI, config schema, discovery parsing, planner/interpreter, codegen, scheduler, reporting, redaction, security (zip/scrub/policies), hook                                                                                                       |
| Contract (`tests/contract`)                     | plugin manifest fields (Claude Code 2.1.71), marketplace, skills frontmatter and engine calls, read-only agent, MCP pins, committed bundle, path lengths                                                                                                 |
| Integration (`tests/integration`, serial, live) | live MCP discovery; generation golden files; sessions/roles/tabs/cancel probe; full-test resume; live security (traces scrubbed, cross-origin aborted); second app end to end; cross-browser                                                             |
| Smokes                                          | MCP JSON-RPC; vertical slice (20 cases, intentional-defect mode); in-Claude plugin and full-test smokes (owner terminal); install smoke (clean clone or GitHub → isolated install → installed engine); credential-hook smoke (owner terminal); benchmark |

Every phase passed `node scripts/quality-gate.mjs <phase>`:

- typecheck, lint, format, build and the full regression suite;
- `claude plugin validate` and `progress check`;
- phase-specific acceptance;

with logs in `evidence/<phase>/` and a review in `docs/PHASE_REVIEWS/<phase>.md`. CI runs on every push to `main`: Linux and Windows checks, plus Linux live integration with three browsers.

## 6. Acceptance results

| Gate                          | Result                                           | Key evidence                                                                                               |
| ----------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| P0 progress foundation        | passed                                           | `docs/PHASE_REVIEWS/P0.md`                                                                                 |
| P1 plugin foundation          | passed                                           | plugin validated and loaded; skills discovered; MCP connected in Claude (owner smoke) — `evidence/P1/`     |
| P2 discovery                  | passed                                           | live exploration 3/3 stable runs — `evidence/P2/`                                                          |
| P3 planning                   | passed                                           | 22 cases from 12 requirements; NEEDS_REVIEW for unmeasurable requirements — `evidence/P3/`                 |
| P4 generation                 | passed                                           | golden specs, strict type-check, `--list` — `evidence/P4/`                                                 |
| P5 sessions and orchestration | passed                                           | roles/contexts/tabs, session refresh, parallel and serial phases — `evidence/P5/`                          |
| P6 vertical slice             | passed                                           | 3× 20/20 identical; the intentional defect gives exactly 2 FAIL, `probable_app_bug` — `evidence/P6/`       |
| P7 reporting and MVP          | passed                                           | in-Claude `/qa-agent:full-test` 7/7 checks (0.68 USD); clean-environment reproduction — `evidence/P7/`     |
| P8 hardening                  | passed                                           | policies enforced at execution; 2 target apps; benchmark baseline; no secret in artifacts — `evidence/P8/` |
| P9 CI, packaging, v1.0        | see [`PHASE_REVIEWS/P9.md`](PHASE_REVIEWS/P9.md) | CI runs, install smokes (local clone and GitHub), release dry-run — `evidence/P9/`                         |

Benchmark baseline (`evidence/P8/benchmark.md`, Windows 11, 14 CPUs):

- live discovery 8.5 s and 26.2 s;
- full regression median 53.8 s (20 cases) and 40.5 s (17 cases) with 2 workers;
- 12/12 regression runs passed with 0 flaky;
- engine RSS 109 MB;
- in-Claude sessions 0.11–0.68 USD, engine reruns 0 tokens.

## 7. Limitations

- **Requirement language.** The planner understands a controlled English subset. Other phrasing becomes NEEDS_REVIEW by design. Rich SPAs (client-side routing without links), file uploads, SSO/MFA logins and email flows are not supported yet.
- **Verified scope.** Two fixture apps, Windows 11 and CI Linux/Windows, Node 22.15, Claude Code 2.1.71, Playwright 1.63. macOS, other versions and production-grade applications are untested ([`RELEASE.md`](RELEASE.md#compatibility-matrix-verified)).
- **Workers** are capped at 2 for the parallel phase until a project proves that more is safe.
- **Flakiness seen under load.** One cold-start Firefox failure in 204 browser-case runs, and one full-test integration failure out of 3 runs during P9, not reproduced in later runs. Both are documented; nothing is retried automatically.
- **The credential hook** covers shell tools only. Its live in-session proof is an owner-terminal smoke (`npm run smoke:claude-hook`).
- **Scrubbing** covers traces, reports and text artifacts, not pixels in screenshots or videos. Secrets shorter than 3 characters are not scrubbed.
- **Strict type-check** of generated code needs TypeScript in the target project; otherwise it is reported as not run.
- **No project license** has been chosen (owner decision). The repository is public but "all rights reserved" until a LICENSE is added.

## 8. Owner actions

1. Decide the license, then add `LICENSE` and the `license` field.
2. Optional: run `npm run smoke:claude-hook` in a normal terminal (about 0.05–0.3 USD).
3. When ready: `git tag v1.0.0 && git push origin v1.0.0`, optionally with a GitHub release ([`RELEASE.md`](RELEASE.md)).

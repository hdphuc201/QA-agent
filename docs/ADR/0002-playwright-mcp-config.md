# ADR 0002 — Playwright MCP integration defaults

- Status: accepted
- Date: 2026-10-19
- Phase: P1 (P1-T03, P1-T05)

## Context

The plugin ships Playwright MCP for exploration (roadmap §1.1, §7.1). Defaults must be safe for any target project: local/staging only, no persistent cookies, no writes outside the allowlist (`.qa-agent/`, `e2e/generated/`, `qa-artifacts/`). Upstream states that Playwright MCP "is not a security boundary".

## Decision

`.mcp.json` at the plugin root declares one stdio server, `playwright`:

| Arg                                                       | Why                                                                                                                                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx -y @playwright/mcp@0.0.83`                           | Exact pin (released 2026-09-28, verified by `scripts/smoke/mcp-smoke.mjs`). `@latest` would change behaviour without review. `-y` avoids an install prompt that would hang a stdio server |
| `--headless`                                              | Works non-interactively and in CI                                                                                                                                                         |
| `--isolated`                                              | Browser profile kept in memory; no cookies/storage on disk                                                                                                                                |
| `--allowed-origins http://localhost:*;http://127.0.0.1:*` | Default to local apps. Per-project origins come from the P2 config                                                                                                                        |
| `--output-dir qa-artifacts/playwright-mcp`                | Without it the server writes `.playwright-mcp/` (page snapshots) into the session cwd, i.e. the target project root. Verified in `evidence/P1/mcp-smoke-output-dir.log`                   |

Not enabled: `--allow-unrestricted-file-access`, `--no-sandbox`, `--extension`, `--caps`, `env` (no secrets). `tests/contract/plugin.test.ts` enforces all of the above.

Verification is done in two layers:

1. `npm run smoke:mcp` starts the server exactly as `.mcp.json` declares, speaks MCP JSON-RPC (no AI) and checks that the snapshot contains a per-run random token from a local demo page. It also checks that a non-allowlisted origin is refused.
2. `npm run smoke:claude` loads the plugin with `claude -p --plugin-dir` and checks the stream-json transcript (plugin, skills, `plugin:qa-agent:playwright` connected, tool calls, token).

Claude Code refuses to run nested in another Claude Code session. The guard is not bypassed (`CLAUDECODE` stays set); layer 2 runs in a normal terminal.

## Consequences

- Exploring a staging host needs the P2 per-project allowlist. Until then only localhost works.
- The first server start downloads the package. Offline machines need a pre-populated npm cache.
- Bumping the version requires re-running both smokes and updating this ADR.
- All 25 upstream tools remain listed (including `browser_run_code_unsafe`); narrowing them is P2/P8 work.

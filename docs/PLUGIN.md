# QA Agent plugin — components and limitations

## Components

| Component      | Path                                                            | Notes                                                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest       | `.claude-plugin/plugin.json`                                    | `qa-agent` 0.1.0; passes `claude plugin validate` (2.1.71)                                                                                                                                                                   |
| Skills         | `skills/{discover,plan,generate,run,report,full-test}/SKILL.md` | all implemented; each calls `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" <stage>`; `disable-model-invocation: true` (user-invoked only)                                                               |
| Agent          | `agents/failure-analyzer.md`                                    | read-only (Read, Grep, Glob); second opinion on failures, returned as JSON and merged by `report`                                                                                                                            |
| Playwright MCP | `.mcp.json`                                                     | `@playwright/mcp@0.0.83`, headless, isolated profile, localhost-only origins by default, output under `qa-artifacts/playwright-mcp/`; discovery overrides the allowlist with the project's `allowedOrigins` (ADR 0002, 0004) |

Skills are invoked as `/qa-agent:<name>`, and every skill ends with a `QA-AGENT-SKILL: <name> | status=… | phase=…` line. `discover --smoke <localhost url>` is a pure MCP connectivity check. The MCP server appears in `/mcp` as `plugin:qa-agent:playwright`; its tools are named `mcp__plugin_qa-agent_playwright__<tool>`.

## Load and check locally

```powershell
claude plugin validate .
claude --plugin-dir D:\path\to\QA-agent          # interactive, from the target project
npm run smoke:mcp                                 # MCP over JSON-RPC, no AI, no cost
npm run smoke:claude                              # plugin + discover --smoke inside Claude Code (~0.11 USD)
node scripts/smoke/claude-fulltest-smoke.mjs      # /qa-agent:full-test inside Claude Code (owner terminal)
```

The `smoke:claude` and full-test smokes must run in a normal terminal, because Claude Code refuses to start inside another Claude Code session. This project does not bypass that guard. Run Claude from the **target project**, not from this repository: the repository root `.mcp.json` doubles as a project-scoped MCP config there.

## Limitations

1. **Claude Code version.** Verified with 2.1.71; newer docs describe more manifest fields (e.g. `displayName`, rejected by 2.1.71). `tests/contract/plugin.test.ts` checks skills, agent and MCP config because 2.1.71's validator checks only the manifest.
2. **Runtime from source.** Skills run the engine from `src/` with Node type stripping (Node ≥ 22.12) and the plugin's own `node_modules` (zod, prettier, typescript). A plugin installed without `npm ci` in its folder will not work yet; packaging is P9.
3. **Origin allowlist** is enforced by QA Agent before and after every navigation, and passed to Playwright MCP as a second layer. Upstream states that MCP is not a security boundary.
4. **Powerful MCP tools are exposed** (`browser_evaluate`, `browser_run_code_unsafe`, `browser_file_upload`). Only `discover` pre-approves navigate/snapshot/close; the discovery engine itself uses only navigate/snapshot/close plus the login recipe. Narrowing the tool set is P8.
5. **Browser.** The evidence used the installed Chrome (`QA_AGENT_BROWSER_CHANNEL=chrome`); the Playwright Chromium download and CI are P9.
6. **First MCP start** downloads the pinned package (network needed).
7. **User-level hooks** of the person running Claude also run in plugin sessions (observed in P1); QA Agent does not control them.
8. **Traces and screenshots** of failed tests can contain session data and typed values (e.g. a password typed into the login form). They stay in gitignored `qa-artifacts/`; reports link them and warn, but do not redact them.
9. **Linux/macOS** are not executed yet (P9 CI).

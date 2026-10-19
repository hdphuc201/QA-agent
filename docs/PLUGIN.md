# QA Agent plugin — usage and limitations (P1)

## What exists after P1

| Component      | Path                         | State                                                                                                                     |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Manifest       | `.claude-plugin/plugin.json` | `qa-agent` 0.1.0, passes `claude plugin validate`                                                                         |
| Skills         | `skills/<name>/SKILL.md`     | `discover`, `plan`, `generate`, `run`, `report`, `full-test` — **skeletons only**                                         |
| Playwright MCP | `.mcp.json`                  | `@playwright/mcp@0.0.83`, headless, isolated profile, localhost-only origins, artifacts in `qa-artifacts/playwright-mcp/` |
| Path adapter   | `src/config/paths.ts`        | plugin root, project root, project config discovery (schema comes in P2)                                                  |

Skills are invoked as `/qa-agent:<name>`. Every skeleton has `disable-model-invocation: true`, so Claude never picks one automatically. When invoked, a skeleton says it is not implemented yet, echoes its arguments and prints `QA-AGENT-SKILL: <name> | status=skeleton | phase=Px`.

The only real action is `/qa-agent:discover --smoke <http://localhost-or-127.0.0.1-url>`. It navigates, snapshots and closes the page through Playwright MCP, then prints `QA-AGENT-MCP-OBSERVATION: title=… | heading=… | token=…`. This proves the MCP connection; it is not discovery.

The MCP server appears in `/mcp` as `plugin:qa-agent:playwright`. Its tools are named `mcp__plugin_qa-agent_playwright__<tool>`.

## Load and check locally

```powershell
claude plugin validate .
claude --plugin-dir D:\path\to\QA-agent          # interactive; then /qa-agent:discover
npm run smoke:mcp                                 # MCP over JSON-RPC, no AI, no cost
npm run smoke:claude                              # inside Claude Code; ~0.11 USD per run
```

`npm run smoke:claude` must run in a normal terminal. Claude Code refuses to start inside another Claude Code session, and this project does not bypass that guard.

Run Claude from the **target project** directory, not from this repository. This repository's root `.mcp.json` doubles as a project-scoped MCP config when Claude Code is started here.

## Limitations (verified in P1)

1. **Claude Code version.** Verified with the local CLI 2.1.71. The current docs describe features up to v2.1.28x. `displayName` in the manifest is rejected by 2.1.71, so it is not used. Newer `claude plugin validate` versions also check `.mcp.json`; 2.1.71 validates only the manifest, so `tests/contract/plugin.test.ts` covers the skills and the MCP config.
2. **Origin allowlist is a guardrail, not a security boundary** (upstream statement). Only `localhost` / `127.0.0.1` are allowed by default; a per-project allowlist arrives with the P2 config. Real enforcement is planned for P8.
3. **Powerful MCP tools are exposed.** The server lists 25 tools, including `browser_evaluate`, `browser_run_code_unsafe` and `browser_file_upload`. Only `discover` pre-approves tools (`navigate`, `snapshot`, `close`); every other tool still needs a permission grant. Restricting the tool set is P2/P8 work.
4. **Browser.** The pinned server uses Playwright 1.64.0-alpha and the default browser channel. On this machine it ran with the installed Chrome. A machine without Chrome may need `npx playwright install` or a `--browser` flag; this has not been tested yet (CI in P9).
5. **`npx` download at first start.** The pinned package is fetched from the npm registry on first use, so the first start needs network access and is slower.
6. **Windows.** `npx` is a `.cmd` shim. Claude Code 2.1.71 starts the server from `.mcp.json` without a `cmd /c` wrapper (verified). The standalone smoke script uses a shell only for `npx`/`npm` with a strict argument whitelist.
7. **User-level hooks run in plugin sessions.** In the smoke runs, a global `SessionStart` hook of the owner created a directory in the session cwd and kept it locked after exit. QA Agent does not control user hooks; the smoke script tolerates it.
8. **Linux/macOS not executed** in P1.

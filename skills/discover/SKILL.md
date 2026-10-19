---
description: "QA Agent discovery. Reads the target project's .qa-agent/config.json, docs and source (read-only) and explores the running app inside allowedOrigins with Playwright MCP, writing a project map and observations with provenance. Use when the user asks to discover, map or explore a web app for QA."
argument-hint: "[--offline] | [--smoke <http://localhost-url>]"
disable-model-invocation: true
allowed-tools: mcp__plugin_qa-agent_playwright__browser_navigate, mcp__plugin_qa-agent_playwright__browser_snapshot, mcp__plugin_qa-agent_playwright__browser_close
---

# QA Agent — discover

Status: **implemented (P2)**. Arguments: $ARGUMENTS

## Discovery

1. Find the target project root (the user's current project). It must contain `.qa-agent/config.json`. If it does not, explain the required fields (`schemaVersion`, `projectId`, `baseURL`, `allowedOrigins`, `docsPaths`, `sourcePaths`, `roles` with `accountKey`) and stop. Never invent a `baseURL`, origins, roles or credentials.
2. Credentials for authenticated exploration come only from environment variables `QA_AGENT_ACCOUNT_<ACCOUNT_KEY>_USERNAME` / `_PASSWORD` (e.g. `demo.requester` → `QA_AGENT_ACCOUNT_DEMO_REQUESTER_*`). Never ask the user to paste a password into the chat and never print one.
3. Run the deterministic engine with the Bash tool (the plugin root is `${CLAUDE_PLUGIN_ROOT}`; if that text was not substituted, use the directory that contains this plugin's `.claude-plugin/plugin.json`):

   ```bash
   node --experimental-strip-types --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" discover --project "<project root>"
   ```

   Add `--offline` when the user wants a static (docs/source only) map or the app is not running.

4. Report from the command output and `.qa-agent/discovery/project-map.json` / `observations.json` only: counts of routes, forms, UI elements and roles; which routes were observed live; the auth status; blocked URLs and why. Keep `observed`, `source-derived` and `hypothesized` items apart.
5. Do not turn observations into expected results. Observed behaviour is not required behaviour; expected results come from requirements (`/qa-agent:plan`).

Exit code 3 means a config problem (show the message); 1 means the stage failed (for example a failed sign-in) — report it, do not retry with guessed credentials.

## Connectivity smoke (`--smoke <url>`)

This checks the Playwright MCP connection only; it is not discovery.

1. Accept the URL only if its host is `localhost` or `127.0.0.1` and its scheme is `http`. Otherwise refuse and stop.
2. Call `browser_navigate` with the URL, then `browser_snapshot`.
3. Report only what the snapshot shows: page title, main heading text, and any text marked as a smoke token. Do not infer requirements or expected behaviour.
4. Call `browser_close`.
5. Print `QA-AGENT-MCP-OBSERVATION: title=<title> | heading=<heading> | token=<token or none>`.

If a Playwright tool is unavailable or fails, print `QA-AGENT-MCP-OBSERVATION: unavailable | <error>` and do not invent page content.

End with the line `QA-AGENT-SKILL: discover | status=implemented | phase=P2`.

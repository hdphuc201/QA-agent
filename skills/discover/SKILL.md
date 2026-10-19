---
description: "QA Agent discovery (skeleton). Will read project config, docs and source and explore an allowed web app with Playwright MCP to build a project map. Currently only offers a localhost MCP connectivity smoke check."
argument-hint: "[--smoke <http://localhost-url>]"
disable-model-invocation: true
allowed-tools: mcp__plugin_qa-agent_playwright__browser_navigate, mcp__plugin_qa-agent_playwright__browser_snapshot, mcp__plugin_qa-agent_playwright__browser_close
---

# QA Agent — discover (skeleton)

Status: **skeleton** — implementation is planned for phase P2 of `QA_AGENT_MASTER_ROADMAP.md`.

Planned behaviour: Read `.qa-agent/config.json`, docs and source paths (read-only), explore the app inside `allowedOrigins` with Playwright MCP, and write `project-map.json` / `observations.json` with provenance (`observed`, `source-derived`, `hypothesized`).

## When invoked now

1. Tell the user this skill is a skeleton and that phase P2 implements it.
2. Apart from the connectivity smoke below, do not explore, plan, generate, run or report anything on its behalf, and never present invented results as QA output.
3. Echo the arguments received: $ARGUMENTS
4. End with the line `QA-AGENT-SKILL: discover | status=skeleton | phase=P2`.

## Connectivity smoke (`--smoke <url>`)

This is the only action this skeleton performs. It proves the Playwright MCP connection; it is not discovery.

1. Accept the URL only if its host is `localhost` or `127.0.0.1` and its scheme is `http`. Otherwise refuse and stop.
2. Call `browser_navigate` with the URL, then `browser_snapshot`.
3. Report only what the snapshot shows: page title, main heading text, and any text marked as a smoke token. Do not infer requirements or expected behaviour.
4. Call `browser_close`.
5. Print `QA-AGENT-MCP-OBSERVATION: title=<title> | heading=<heading> | token=<token or none>`.

If a Playwright tool is unavailable or fails, print `QA-AGENT-MCP-OBSERVATION: unavailable | <error>` and do not invent page content.

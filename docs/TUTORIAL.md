# Tutorial: install QA Agent and test two projects

This tutorial installs the plugin the way a user does (from the GitHub marketplace) and sets it up for two different web apps. Both apps ship with this repository as fixtures, so every step can be reproduced:

| Project                     | What it is                                               | Differs in                                                                                  |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A — `examples/sample-app`   | purchase-request approvals (requester, approver, viewer) | plain `node:http` routing, `/login` with Username/Password, output in `e2e/generated`       |
| B — `examples/helpdesk-app` | helpdesk tickets (customer, agent, auditor)              | Express-style routing, `/signin` with Email/Passphrase, output in `tests/qa`, cross-browser |

Commands are for PowerShell; in Bash use `export NAME=value` instead of `$env:NAME = 'value'`. The demo passwords are fixture values of these local apps, not secrets of a real system.

## 0. Prerequisites

- Node.js 22 or newer (`node --version`)
- Claude Code 2.1.71 or newer (`claude --version`)
- Google Chrome (Playwright MCP explores with it)

## 1. Install the plugin

```powershell
claude plugin marketplace add hdphuc201/QA-agent
claude plugin install qa-agent@qa-agent
claude plugin list          # qa-agent@qa-agent … Status: enabled
```

The installed copy lives under `~/.claude/plugins/cache/qa-agent/qa-agent/<version>/`. It needs no `npm install`: the engine is the self-contained `bin/qa-agent.mjs`. To work on QA Agent itself, use a clone and `claude --plugin-dir <clone>` instead.

In the steps below, `$QA` is the engine, for running stages without Claude:

```powershell
$QA = (Get-ChildItem "$HOME\.claude\plugins\cache\qa-agent\qa-agent" | Select-Object -Last 1).FullName + '\bin\qa-agent.mjs'
```

## 2. Project A — approvals app

**Prepare the project** (any folder outside this repository):

```powershell
git clone https://github.com/hdphuc201/QA-agent qa-agent-src
New-Item -ItemType Directory approvals | Out-Null
Copy-Item -Recurse qa-agent-src/examples/sample-app/server.mjs, qa-agent-src/examples/sample-app/docs, qa-agent-src/examples/sample-app/.qa-agent approvals/
cd approvals
npm init -y | Out-Null
npm install --save-dev --save-exact @playwright/test@1.63.0 typescript @types/node   # typescript: strict type-check of generated tests (optional)
```

`.qa-agent/config.json` is the only QA Agent file you write. It sets the base URL, allowed origins, roles (by account key, never passwords), the login recipe, docs and source paths, and the output folder. Field reference: [`CONFIG_GUIDE.md`](CONFIG_GUIDE.md). Requirements are Markdown in the controlled format: [`REQUIREMENTS_FORMAT.md`](REQUIREMENTS_FORMAT.md).

**Start the app** (keep this terminal open):

```powershell
$env:SAMPLE_APP_TEST_MODE = '1'; node server.mjs 4100
```

**Credentials, in a second terminal** (from the account keys in the config):

```powershell
$env:QA_AGENT_ACCOUNT_DEMO_REQUESTER_USERNAME = 'alice';  $env:QA_AGENT_ACCOUNT_DEMO_REQUESTER_PASSWORD = 'alice-demo'
$env:QA_AGENT_ACCOUNT_DEMO_APPROVER_USERNAME  = 'bob';    $env:QA_AGENT_ACCOUNT_DEMO_APPROVER_PASSWORD  = 'bob-demo'
$env:QA_AGENT_ACCOUNT_DEMO_VIEWER_USERNAME    = 'victor'; $env:QA_AGENT_ACCOUNT_DEMO_VIEWER_PASSWORD    = 'victor-demo'
$env:QA_AGENT_BROWSER_CHANNEL = 'chrome'
```

**Run it from Claude Code** (in that second terminal, inside `approvals/`):

```powershell
claude
```

Then type `/qa-agent:full-test`. Claude runs discover → plan → generate → run → report. When there are failures, it asks the read-only `failure-analyzer` agent for a second opinion. Expected: 22 cases (20 READY, 2 NEEDS_REVIEW), 20/20 passed.

**Or without Claude** (same engine, same result):

```powershell
node $QA full-test --project .
node $QA full-test --project . --resume     # later: skips stages whose inputs did not change
```

**Read the results:**

| Where                                          | What                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `.qa-agent/plan/test-plan.md`                  | every case with the requirement line it comes from                                                              |
| `e2e/generated/`                               | readable Playwright specs; plain `npx playwright test -c e2e/generated/playwright.qa-agent.config.ts` works too |
| `qa-artifacts/runs/<runId>/report/report.html` | the report: verdicts per case and requirement, evidence, failure analysis                                       |

**See a defect being caught:** restart the app with `$env:SAMPLE_APP_BUG = 'skip-approve-rbac'` and run `node $QA run --project .; node $QA report --project .`. The two API authorization cases fail and are classified `probable_app_bug`.

## 3. Project B — helpdesk app

```powershell
New-Item -ItemType Directory helpdesk | Out-Null
Copy-Item -Recurse qa-agent-src/examples/helpdesk-app/server.mjs, qa-agent-src/examples/helpdesk-app/docs, qa-agent-src/examples/helpdesk-app/.qa-agent helpdesk/
cd helpdesk
npm init -y | Out-Null
npm install --save-dev --save-exact @playwright/test@1.63.0
$env:HELPDESK_TEST_MODE = '1'; node server.mjs 4200      # first terminal
```

What is different in its `.qa-agent/config.json`:

```json
"testOutputRoot": "tests/qa",
"roles": [{ "name": "customer", "accountKey": "helpdesk.customer" }, …],
"session": { "cache": true, "verifyPath": "/tickets" },
"testData": { "resetPath": "/__qa/reset" },
"exploration": { "authRole": "customer", "auth": { "loginPath": "/signin", "usernameLabel": "Email", "passwordLabel": "Passphrase", "submitButton": "Log in" } }
```

```powershell
$env:QA_AGENT_ACCOUNT_HELPDESK_CUSTOMER_USERNAME = 'carol@helpdesk.test'; $env:QA_AGENT_ACCOUNT_HELPDESK_CUSTOMER_PASSWORD = 'carol-helpdesk'
$env:QA_AGENT_ACCOUNT_HELPDESK_AGENT_USERNAME    = 'dan@helpdesk.test';   $env:QA_AGENT_ACCOUNT_HELPDESK_AGENT_PASSWORD    = 'dan-helpdesk'
$env:QA_AGENT_ACCOUNT_HELPDESK_AUDITOR_USERNAME  = 'erin@helpdesk.test';  $env:QA_AGENT_ACCOUNT_HELPDESK_AUDITOR_PASSWORD  = 'erin-helpdesk'
node $QA full-test --project .
```

Expected: 17/17 passed. This project has no TypeScript installed, so the generate stage reports `type-check not run (no TypeScript)`. That is not a pass: Playwright still compiles and lists every test. Install `typescript @types/node` to get the strict check.

**Cross-browser:** add `"browsers": ["chromium", "firefox", "webkit"]` to the config, run `npx playwright install firefox webkit` once, then `full-test` again. Each case runs in every browser; the report shows the worst browser per case and lists all of them.

## 4. Your own project

1. Write `.qa-agent/config.json` for a **local or staging** environment. Production is refused unless the owner sets `QA_AGENT_ALLOW_PRODUCTION=1`.
2. Write requirements with measurable `Expected` lines. Anything the planner cannot interpret becomes `NEEDS_REVIEW` and is not run.
3. Install `@playwright/test` (plus `typescript @types/node` for the strict type-check).
4. Put credentials in the environment as `QA_AGENT_ACCOUNT_<ACCOUNT KEY>_USERNAME/_PASSWORD`, never in files.
5. Run `/qa-agent:full-test`, or `node $QA full-test --project .`.

## Troubleshooting

| Symptom                                                         | Meaning / fix                                                                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `BLOCKED: missing QA_AGENT_ACCOUNT_…`                           | that role's credentials are not set in this terminal                                                                   |
| `BLOCKED: the target project has no @playwright/test installed` | `npm install --save-dev @playwright/test` in the target project                                                        |
| `policy: refusing to … against a production environment`        | intended; use a staging environment                                                                                    |
| A case is BLOCKED with "destructive action"                     | the step deletes or removes something; allow it with `"policy": { "allowDestructive": true }` only for disposable data |
| Claude says the credential guard refused a command              | intended: values must never reach the transcript; check presence with the `set`/`MISSING` command shown in the message |
| `browserType.launch: Executable doesn't exist`                  | `npx playwright install chromium` (or `firefox`, `webkit`)                                                             |

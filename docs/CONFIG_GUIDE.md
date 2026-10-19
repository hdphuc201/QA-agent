# `.qa-agent/config.json` guide

The file lives in the **target project**. It is validated by `src/config/project-config.schema.ts` (Zod; strict: unknown keys are errors). Credentials never go here: keys that look like secrets (`password`, `apiKey`, `token`, …) are rejected.

## Minimal

```json
{
  "schemaVersion": 1,
  "projectId": "shop-web",
  "baseURL": "http://localhost:3000/",
  "allowedOrigins": ["http://localhost:3000"]
}
```

## Fields

| Field            | Default                                                                             | Meaning                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`  | —                                                                                   | `1`                                                                                                                                                                            |
| `projectId`      | —                                                                                   | kebab-case id                                                                                                                                                                  |
| `framework`      | —                                                                                   | free text, informational                                                                                                                                                       |
| `environment`    | `local`                                                                             | `local` · `staging` · `production`. Production forbids `testData.resetPath`; QA Agent never runs destructive steps there                                                       |
| `baseURL`        | —                                                                                   | where the app runs; its origin must be in `allowedOrigins`                                                                                                                     |
| `allowedOrigins` | —                                                                                   | exact origins (`https://staging.example.com`, no path) the browser may load                                                                                                    |
| `docsPaths`      | `[]`                                                                                | project-relative docs to read (requirements are parsed from Markdown here)                                                                                                     |
| `sourcePaths`    | `[]`                                                                                | project-relative source to scan for routes/forms/roles (read-only)                                                                                                             |
| `readOnlyPaths`  | `[]`                                                                                | paths QA Agent must never write to                                                                                                                                             |
| `testOutputRoot` | `e2e/generated`                                                                     | where specs are generated; must not overlap `sourcePaths` or `readOnlyPaths`                                                                                                   |
| `roles[]`        | `[]`                                                                                | `{ "name": "approver", "accountKey": "demo.approver", "description"? }`                                                                                                        |
| `workers`        | `{ "max": 1, "writeHeavy": 1 }`                                                     | `max`: parallel budget for isolated cases (QA Agent caps at 2); `writeHeavy`: default for plain `npx playwright test`                                                          |
| `session`        | `{ "cache": false, "maxAgeMinutes": 15, "verifyPath": "/", "purgeAfterRun": true }` | reuse signed-in sessions per role. A session is used only if `verifyPath` loads without landing on the login page; enable only for apps that redirect anonymous users to login |
| `testData`       | —                                                                                   | `{ "resetPath": "/api/test/reset", "resetOn": "before" \| "after" \| "both" }` — POST endpoint that resets test data                                                           |
| `exploration`    | `{ "maxPages": 20, "timeoutMs": 30000, "retries": 1 }`                              | live discovery limits; `authRole` + `auth` (login recipe) for signed-in exploration and for generated tests                                                                    |

Login recipe (`exploration.auth`), used by discovery **and** by the generated tests:

```json
"auth": { "loginPath": "/login", "usernameLabel": "Username", "passwordLabel": "Password", "submitButton": "Sign in" }
```

Labels and button text are matched exactly (accessible names).

## Credentials

For each role's `accountKey` set two environment variables before running (`.` and `-` become `_`, uppercased):

```powershell
$env:QA_AGENT_ACCOUNT_DEMO_APPROVER_USERNAME = 'bob'
$env:QA_AGENT_ACCOUNT_DEMO_APPROVER_PASSWORD = '<from your secret store>'
```

A missing variable makes the affected tests report `BLOCKED` (not FAIL).

## Other environment variables

| Variable                               | Effect                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `QA_AGENT_BASE_URL`                    | override `baseURL` at run time (must still be an allowed origin)                        |
| `QA_AGENT_BROWSER_CHANNEL`             | e.g. `chrome` to use the installed Chrome instead of Playwright's Chromium              |
| `QA_AGENT_WORKERS`, `QA_AGENT_RETRIES` | for plain `npx playwright test -c …/playwright.qa-agent.config.ts`                      |
| `QA_AGENT_BUILD_ID`                    | build identifier shown in reports (default: `git rev-parse --short HEAD` of the target) |
| `QA_AGENT_SKIP_LIVE=1`                 | QA Agent's own test suite: skip browser tests                                           |

The complete example is `examples/sample-app/.qa-agent/config.json`.

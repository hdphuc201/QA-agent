# ADR 0006 — Sessions, roles and run orchestration

- Status: accepted
- Date: 2026-10-19
- Phase: P5

## Decisions

1. **Roles → contexts.** Each role gets its own BrowserContext (separate cookies). Extra tabs share their role's context. `anonymous` is a context that never signs in. All contexts close in the fixture's `finally`; a leak check runs in the integration suite.
2. **Credentials** stay references: `accountKey` in config, values only from `QA_AGENT_ACCOUNT_<KEY>_*` at run time. They are never written to disk.
3. **Session cache (opt-in, `session.cache`).** After a UI sign-in, the role's storageState is written atomically to `qa-artifacts/auth/<role>.json` (gitignored). A cached session is reused only if it is younger than `maxAgeMinutes` **and** `verifyPath` loads without landing on the login page. Otherwise the role signs in again ("expired" → "signed-in"), which is the controlled refresh. Events are attached to each test as `qa-session` annotations.
4. **Sign-in under test never uses the cache.** The planner marks the logins it inserts as `implicit`. A role with an explicit login step (valid or wrong password) gets a `fresh` context. Without this, the "Sign in with valid credentials" case had silently stopped testing sign-in (caught by inspecting the session events).
5. **Session files hold cookies.** They are purged by globalSetup (leftovers of an interrupted run), by globalTeardown, and by the engine after every `qa-agent run`. Playwright does not run the purge for an interrupted (global-timeout) run, and nothing can clean up after a hard kill until the next run (measured in `tests/integration/sessions.test.ts`).
6. **Isolation analysis** (`src/orchestrator/isolation.ts`). A case is `isolated` when it only mutates data it created (captured subject, unique values). It is `serial` when it reads or changes shared state, e.g. "no request is created" counts a list that parallel tests of the same role grow. Serial cases are tagged `@serial`.
7. **Scheduler and `qa-agent run`.** The scheduler computes dependency levels (setup is inlined; levels explain failures, they do not gate). Isolated cases run in a parallel phase with `min(workers.max, 2)` workers, then serial cases with 1 worker. The cap of 2 stays until a project proves more. The engine runs only the plan's generated spec files, records `schedule.json`, `results-<phase>.json` and `run.json` under `qa-artifacts/runs/<runId>/`, and passes `QA_AGENT_RUN_ID`. A plain `npx playwright test -c …` keeps the safe default of `workers.writeHeavy` (1).
8. **Waiting and timeouts.** Assertions use Playwright auto-waiting and `expect.poll` (no sleeps): action 10 s, navigation 30 s, expect 10 s, test 60 s. Retries default to 0 so flakes stay visible.
9. **Validation needs `@types/node`.** Playwright's own typings import Node modules, and the runtime uses `node:fs`.

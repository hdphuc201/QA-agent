# Requirement format understood by the QA Agent planner

The planner (`src/planning/`) turns requirement documents into executable test cases **without AI**. It reads Markdown files under the project's `docsPaths`. Expected results come only from `Expected` lines. Discovered UI (project map) is used to resolve _how_ to act (which link opens which form, which button submits it), never _what_ to expect (roadmap §7.2).

A sentence the planner does not recognise becomes a `manual` step or check. The case is then `NEEDS_REVIEW` and is not run, so the planner never guesses.

## Structure

```markdown
### <ID> — <title> (ID: uppercase, dash-separated, e.g. SHOP-REQ-012)

- Feature: <name>
- Priority: P0 | P1 | P2 (default P2)
- Actors: <role>, <role> (role names from .qa-agent/config.json, or "anonymous")
- Given: <precondition> (0..n)
- When: <action> (0..n)
- Rule: <free text> (documentation only)
- Boundary (<label>): <field> <v1>, <v2>
- Expected: <result> (0..n; the only source of expected results)
- Expected (<label>): <result for boundary values with that label>
- Note: <free text>
```

Any other heading ends the requirement block. A requirement without `Expected` lines produces one `NEEDS_REVIEW` case ("no expected result is defined").

## Case generation

| Requirement shape                                 | Cases                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| No `When`                                         | one case per `Expected` line (independent checks)                                       |
| `When` acted by "a A or B"                        | one case per actor                                                                      |
| `Boundary (label): field v1, v2`                  | one case per value; expectations with that label (or no label)                          |
| Positive flow + a negative API expectation        | the API check becomes its own case (`rbac` for 401/403, else `negative`)                |
| `Given: a <status> <thing> created by the <role>` | the case that creates a `<status>` subject becomes setup + dependency; none → `BLOCKED` |

Every role except `anonymous` is signed in before its first use (login recipe from the config). A case that tests signing in (`signs in with …`) is not signed in implicitly.

## Recognised sentences

`When` / `Given` (subject prefix such as "the requester" is ignored):

| Sentence                                             | Step                                                                                                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signs in with a valid username and password`        | login                                                                                                                                                                                                                 |
| `signs in with a wrong password`                     | login with a wrong password                                                                                                                                                                                           |
| ``opens `/path` `` · `is on `/path``                 | open path                                                                                                                                                                                                             |
| `opens the request` · `tries to approve it`          | open the subject                                                                                                                                                                                                      |
| `submits "<link>" with a title and an amount of 250` | open the page of link `<link>`, fill the form fields (`a X` = unique value, `an empty X` = "", `a X of V` = V, `the X under test` = boundary value), click its submit button, remember the result page as the subject |
| `enters a reason`                                    | fill "Reason" with a unique value                                                                                                                                                                                     |
| `clicks "<name>"`                                    | click the button/link with that accessible name                                                                                                                                                                       |
| `is signed in`                                       | (implicit login)                                                                                                                                                                                                      |

With a subject (`Given: a pending …`), a role's first fill/click happens on the subject page unless the sentence opened another page first. Several actions may be joined with `and` before a verb ("opens the request and clicks "Approve"").

`Expected`:

| Sentence contains                                                                      | Assertion                                                                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| ``…`GET /api/x` … returns HTTP 401`` / ``returns HTTP 400 from `POST /api/x/<id>/y` `` | API status as the actor (`without a session` → anonymous, `without a reason` → empty `reason` field, `<id>` → subject id) |
| ``redirected to `/p` `` · ``stays on `/p` `` · ``page `/p` ``                          | URL path                                                                                                                  |
| `the heading "X"`                                                                      | heading                                                                                                                   |
| `the alert "X" is shown`                                                               | alert text                                                                                                                |
| `shows "X"`                                                                            | visible text                                                                                                              |
| `shows the title` · `the reason is shown`                                              | the unique value entered for that field                                                                                   |
| ``appears on … `/p` ``                                                                 | open `/p`, the entered title is visible                                                                                   |
| `status is "X"` · `stays "X"` · `sees the status "X" for that request`                 | text X (on the subject when another role or "for that request")                                                           |
| `no "X" button` / `no "X" link`                                                        | element absent                                                                                                            |
| `no <thing> is created`                                                                | the list API `GET /api/<things>` (from the project map) returns as many items as before                                   |

Ending an `Expected` sentence with `in a second tab` runs its navigation and checks in a second tab of the same role (same session); the tab first opens the subject.

Logins the planner inserts are marked `implicit`. A login written in the requirement (`signs in with …`) tests signing in, so that role always starts from a fresh browser context, never from a cached session.

Network failure and concurrency cases are generated only when a requirement mentions them. If the condition cannot be expressed, those cases are `NEEDS_REVIEW`.

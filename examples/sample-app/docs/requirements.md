# Sample Approvals — Requirements

Fixture requirements for the QA Agent sample app (`examples/sample-app/server.mjs`). They are **not** requirements of any real product (e.g. CHUNJI).

Format: each requirement is a level-3 heading `### <ID> — <title>` followed by `- Key: value` lines (see `docs/REQUIREMENTS_FORMAT.md` in the QA Agent repository). `Expected` lines are the only accepted source of expected results.

## Roles

| Role      | Account key              | Can                                                  |
| --------- | ------------------------ | ---------------------------------------------------- |
| requester | `demo.requester` (alice) | create requests, see own requests                    |
| approver  | `demo.approver` (bob)    | see all requests, approve or reject pending requests |
| viewer    | `demo.viewer` (victor)   | see all requests, read-only                          |

## Authentication

### DEMO-REQ-AUTH-001 — Sign in with valid credentials

- Feature: Authentication
- Priority: P0
- Actors: requester
- Given: the user is on `/login`
- When: the user signs in with a valid username and password
- Expected: the requests page `/` is shown with the heading "Requests"
- Expected: the header shows "Signed in as Alice (requester)"

### DEMO-REQ-AUTH-002 — Reject invalid credentials

- Feature: Authentication
- Priority: P1
- Actors: requester
- Given: the user is on `/login`
- When: the user signs in with a wrong password
- Expected: the alert "Invalid username or password" is shown
- Expected: the user stays on `/login`

### DEMO-REQ-AUTH-003 — Protect pages from anonymous users

- Feature: Authentication
- Priority: P0
- Actors: anonymous
- When: an anonymous user opens `/`
- Expected: the user is redirected to `/login`
- Expected: `GET /api/requests` without a session returns HTTP 401

## Purchase requests

### DEMO-REQ-REQ-001 — Create a purchase request

- Feature: Requests
- Priority: P0
- Actors: requester
- Given: the requester is signed in
- When: the requester submits "New request" with a title and an amount of 250
- Expected: the request detail page shows the title and the status "Pending"
- Expected: the request appears on the requests page `/` with the status "Pending"

### DEMO-REQ-REQ-002 — Title is required

- Feature: Requests
- Priority: P1
- Actors: requester
- When: the requester submits "New request" with an empty title and an amount of 250
- Expected: the alert "Title is required" is shown
- Expected: no request is created

### DEMO-REQ-REQ-003 — Amount limits

- Feature: Requests
- Priority: P1
- Actors: requester
- Rule: the amount must be a whole number from 1 to 10000 (inclusive)
- When: the requester submits "New request" with a title and the amount under test
- Boundary (accepted): amount 1, 10000
- Boundary (rejected): amount 0, 10001
- Expected (accepted): the request detail page shows the status "Pending"
- Expected (rejected): the alert "Amount must be a whole number between 1 and 10000" is shown

### DEMO-REQ-REQ-004 — Requests are easy to find

- Feature: Requests
- Priority: P2
- Actors: requester
- Note: stakeholders want requests to be "easy to find"; no measurable expected result has been agreed yet.

## Approval

### DEMO-REQ-APP-001 — Approver approves a pending request

- Feature: Approval
- Priority: P0
- Actors: requester, approver
- Given: a pending request created by the requester
- When: the approver opens the request and clicks "Approve"
- Expected: the request status is "Approved"
- Expected: the requester sees the status "Approved" for that request

### DEMO-REQ-APP-002 — Approver rejects with a reason

- Feature: Approval
- Priority: P1
- Actors: requester, approver
- Given: a pending request created by the requester
- When: the approver enters a reason and clicks "Reject"
- Expected: the request status is "Rejected" and the reason is shown
- Expected: rejecting without a reason returns HTTP 400 from `POST /api/requests/<id>/reject`

### DEMO-REQ-APP-003 — Only approvers can decide

- Feature: Approval
- Priority: P0
- Actors: requester, viewer
- Given: a pending request
- When: a requester or viewer tries to approve it
- Expected: no "Approve" button is shown to them
- Expected: `POST /api/requests/<id>/approve` returns HTTP 403 for them
- Expected: the request stays "Pending"

### DEMO-REQ-VIEW-001 — Viewer is read-only

- Feature: Access control
- Priority: P1
- Actors: viewer
- Expected: the viewer sees all requests on `/`
- Expected: the viewer has no "New request" link
- Expected: `POST /api/requests` returns HTTP 403 for the viewer

### DEMO-REQ-APP-004 — Decision is visible in another tab

- Feature: Approval
- Priority: P2
- Actors: requester, approver
- Given: a pending request created by the requester
- When: the approver opens the request and clicks "Approve"
- Expected: the requester sees the status "Approved" for that request in a second tab

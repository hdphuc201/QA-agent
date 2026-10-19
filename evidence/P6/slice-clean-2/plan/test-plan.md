# Test plan — sample-approvals

- Generated: 2026-10-19T12:14:18.244Z (schemaVersion 1)
- Requirements: 12, with READY cases: 11
- Cases: 22 (READY 20, not runnable 2)
- Categories not required by any requirement: network-failure, concurrency
- Duplicates merged: —

Expected results quote requirement lines only; observed UI behaviour is never used as an expected result.

| Case | Status | Category | Priority | Risk | Requirements | Title |
|---|---|---|---|---|---|---|
| DEMO-REQ-APP-003-001 | READY | rbac | P0 | 1 | DEMO-REQ-APP-003 | Only approvers can decide — as requester |
| DEMO-REQ-APP-003-002 | READY | rbac | P0 | 1 | DEMO-REQ-APP-003 | Only approvers can decide — as requester — API denies access |
| DEMO-REQ-APP-003-003 | READY | rbac | P0 | 1 | DEMO-REQ-APP-003 | Only approvers can decide — as viewer |
| DEMO-REQ-APP-003-004 | READY | rbac | P0 | 1 | DEMO-REQ-APP-003 | Only approvers can decide — as viewer — API denies access |
| DEMO-REQ-AUTH-003-001 | READY | rbac | P0 | 1 | DEMO-REQ-AUTH-003 | Protect pages from anonymous users |
| DEMO-REQ-AUTH-003-002 | READY | rbac | P0 | 1 | DEMO-REQ-AUTH-003 | Protect pages from anonymous users — API denies access |
| DEMO-REQ-APP-001-001 | READY | state-transition | P0 | 0.9 | DEMO-REQ-APP-001 | Approver approves a pending request |
| DEMO-REQ-AUTH-001-001 | READY | happy | P0 | 0.7 | DEMO-REQ-AUTH-001 | Sign in with valid credentials |
| DEMO-REQ-REQ-001-001 | READY | happy | P0 | 0.7 | DEMO-REQ-REQ-001 | Create a purchase request |
| DEMO-REQ-VIEW-001-002 | READY | rbac | P1 | 0.6 | DEMO-REQ-VIEW-001 | Viewer is read-only — the viewer has no "New request" link |
| DEMO-REQ-VIEW-001-003 | READY | rbac | P1 | 0.6 | DEMO-REQ-VIEW-001 | Viewer is read-only — `POST /api/requests` returns HTTP 403 for the viewer |
| DEMO-REQ-APP-002-001 | READY | state-transition | P1 | 0.54 | DEMO-REQ-APP-002 | Approver rejects with a reason |
| DEMO-REQ-APP-002-002 | READY | negative | P1 | 0.48 | DEMO-REQ-APP-002 | Approver rejects with a reason — API rejects invalid input |
| DEMO-REQ-AUTH-002-001 | READY | negative | P1 | 0.48 | DEMO-REQ-AUTH-002 | Reject invalid credentials |
| DEMO-REQ-REQ-002-001 | READY | negative | P1 | 0.48 | DEMO-REQ-REQ-002 | Title is required |
| DEMO-REQ-REQ-003-001 | READY | boundary | P1 | 0.48 | DEMO-REQ-REQ-003 | Amount limits — amount 1 (accepted) |
| DEMO-REQ-REQ-003-002 | READY | boundary | P1 | 0.48 | DEMO-REQ-REQ-003 | Amount limits — amount 10000 (accepted) |
| DEMO-REQ-REQ-003-003 | READY | boundary | P1 | 0.48 | DEMO-REQ-REQ-003 | Amount limits — amount 0 (rejected) |
| DEMO-REQ-REQ-003-004 | READY | boundary | P1 | 0.48 | DEMO-REQ-REQ-003 | Amount limits — amount 10001 (rejected) |
| DEMO-REQ-VIEW-001-001 | NEEDS_REVIEW | happy | P1 | 0.42 | DEMO-REQ-VIEW-001 | Viewer is read-only — the viewer sees all requests on `/` |
| DEMO-REQ-APP-004-001 | READY | state-transition | P2 | 0.27 | DEMO-REQ-APP-004 | Decision is visible in another tab |
| DEMO-REQ-REQ-004-001 | NEEDS_REVIEW | happy | P2 | 0.21 | DEMO-REQ-REQ-004 | Requests are easy to find |

## Needs review / blocked

- **DEMO-REQ-VIEW-001-001** (NEEDS_REVIEW): contains manual steps or checks
- **DEMO-REQ-REQ-004-001** (NEEDS_REVIEW): no expected result is defined in the requirement

## Cases

### DEMO-REQ-APP-003-001 — Only approvers can decide — as requester

- Status: READY · rbac · P0 (risk 1)
- Requirements: DEMO-REQ-APP-003; depends on: DEMO-REQ-REQ-001-001
- Actors: requester (demo.requester)
- Setup:
  - [requester] sign in
  - [requester] open /requests/new
  - [requester] fill "Title" with <unique title>
  - [requester] fill "Amount" with "250"
  - [requester] click button "Create request" (remember page as subject)
- Steps:
  - [requester] open {{subject.path}}
- Expected:
  - "no "Approve" button is shown to them" — docs/requirements.md:115
    - check [requester] no button "Approve"
  - "the request stays "Pending"" — docs/requirements.md:117
    - then [requester] open {{subject.path}}
    - check [requester] text "Pending" is visible

### DEMO-REQ-APP-003-002 — Only approvers can decide — as requester — API denies access

- Status: READY · rbac · P0 (risk 1)
- Requirements: DEMO-REQ-APP-003; depends on: DEMO-REQ-REQ-001-001
- Actors: requester (demo.requester)
- Setup:
  - [requester] sign in
  - [requester] open /requests/new
  - [requester] fill "Title" with <unique title>
  - [requester] fill "Amount" with "250"
  - [requester] click button "Create request" (remember page as subject)
- Expected:
  - "`POST /api/requests/<id>/approve` returns HTTP 403 for them" — docs/requirements.md:116
    - check [requester] POST /api/requests/{{subject.id}}/approve → HTTP 403

### DEMO-REQ-APP-003-003 — Only approvers can decide — as viewer

- Status: READY · rbac · P0 (risk 1)
- Requirements: DEMO-REQ-APP-003; depends on: DEMO-REQ-REQ-001-001
- Actors: viewer (demo.viewer), requester (demo.requester)
- Setup:
  - [requester] sign in
  - [requester] open /requests/new
  - [requester] fill "Title" with <unique title>
  - [requester] fill "Amount" with "250"
  - [requester] click button "Create request" (remember page as subject)
- Steps:
  - [viewer] sign in
  - [viewer] open {{subject.path}}
- Expected:
  - "no "Approve" button is shown to them" — docs/requirements.md:115
    - check [viewer] no button "Approve"
  - "the request stays "Pending"" — docs/requirements.md:117
    - then [viewer] open {{subject.path}}
    - check [viewer] text "Pending" is visible

### DEMO-REQ-APP-003-004 — Only approvers can decide — as viewer — API denies access

- Status: READY · rbac · P0 (risk 1)
- Requirements: DEMO-REQ-APP-003; depends on: DEMO-REQ-REQ-001-001
- Actors: viewer (demo.viewer), requester (demo.requester)
- Setup:
  - [requester] sign in
  - [requester] open /requests/new
  - [requester] fill "Title" with <unique title>
  - [requester] fill "Amount" with "250"
  - [requester] click button "Create request" (remember page as subject)
- Steps:
  - [viewer] sign in
- Expected:
  - "`POST /api/requests/<id>/approve` returns HTTP 403 for them" — docs/requirements.md:116
    - check [viewer] POST /api/requests/{{subject.id}}/approve → HTTP 403

### DEMO-REQ-AUTH-003-001 — Protect pages from anonymous users

- Status: READY · rbac · P0 (risk 1)
- Requirements: DEMO-REQ-AUTH-003; depends on: —
- Actors: anonymous
- Steps:
  - [anonymous] open /
- Expected:
  - "the user is redirected to `/login`" — docs/requirements.md:43
    - check [anonymous] URL path is /login

### DEMO-REQ-AUTH-003-002 — Protect pages from anonymous users — API denies access

- Status: READY · rbac · P0 (risk 1)
- Requirements: DEMO-REQ-AUTH-003; depends on: —
- Actors: anonymous
- Expected:
  - "`GET /api/requests` without a session returns HTTP 401" — docs/requirements.md:44
    - check [anonymous] GET /api/requests → HTTP 401

### DEMO-REQ-APP-001-001 — Approver approves a pending request

- Status: READY · state-transition · P0 (risk 0.9)
- Requirements: DEMO-REQ-APP-001; depends on: DEMO-REQ-REQ-001-001
- Actors: approver (demo.approver), requester (demo.requester)
- Setup:
  - [requester] sign in
  - [requester] open /requests/new
  - [requester] fill "Title" with <unique title>
  - [requester] fill "Amount" with "250"
  - [requester] click button "Create request" (remember page as subject)
- Steps:
  - [approver] sign in
  - [approver] open {{subject.path}}
  - [approver] click button "Approve"
- Expected:
  - "the request status is "Approved"" — docs/requirements.md:95
    - check [approver] text "Approved" is visible
  - "the requester sees the status "Approved" for that request" — docs/requirements.md:96
    - then [requester] open {{subject.path}}
    - check [requester] text "Approved" is visible

### DEMO-REQ-AUTH-001-001 — Sign in with valid credentials

- Status: READY · happy · P0 (risk 0.7)
- Requirements: DEMO-REQ-AUTH-001; depends on: —
- Actors: requester (demo.requester)
- Steps:
  - [requester] open /login
  - [requester] sign in
- Expected:
  - "the requests page `/` is shown with the heading "Requests"" — docs/requirements.md:24
    - check [requester] URL path is /
    - check [requester] heading "Requests" is visible
  - "the header shows "Signed in as Alice (requester)"" — docs/requirements.md:25
    - check [requester] text "Signed in as Alice (requester)" is visible

### DEMO-REQ-REQ-001-001 — Create a purchase request

- Status: READY · happy · P0 (risk 0.7)
- Requirements: DEMO-REQ-REQ-001; depends on: —
- Actors: requester (demo.requester)
- Steps:
  - [requester] sign in
  - [requester] open /requests/new
  - [requester] fill "Title" with <unique title>
  - [requester] fill "Amount" with "250"
  - [requester] click button "Create request" (remember page as subject)
- Expected:
  - "the request detail page shows the title and the status "Pending"" — docs/requirements.md:55
    - check [requester] text <data.title> is visible
    - check [requester] text "Pending" is visible
  - "the request appears on the requests page `/` with the status "Pending"" — docs/requirements.md:56
    - then [requester] open /
    - check [requester] URL path is /
    - check [requester] text <data.title> is visible
    - check [requester] text "Pending" is visible

### DEMO-REQ-VIEW-001-002 — Viewer is read-only — the viewer has no "New request" link

- Status: READY · rbac · P1 (risk 0.6)
- Requirements: DEMO-REQ-VIEW-001; depends on: —
- Actors: viewer (demo.viewer)
- Steps:
  - [viewer] sign in
- Expected:
  - "the viewer has no "New request" link" — docs/requirements.md:125
    - check [viewer] no link "New request"

### DEMO-REQ-VIEW-001-003 — Viewer is read-only — `POST /api/requests` returns HTTP 403 for the viewer

- Status: READY · rbac · P1 (risk 0.6)
- Requirements: DEMO-REQ-VIEW-001; depends on: —
- Actors: viewer (demo.viewer)
- Steps:
  - [viewer] sign in
- Expected:
  - "`POST /api/requests` returns HTTP 403 for the viewer" — docs/requirements.md:126
    - check [viewer] POST /api/requests → HTTP 403

### DEMO-REQ-APP-002-001 — Approver rejects with a reason

- Status: READY · state-transition · P1 (risk 0.54)
- Requirements: DEMO-REQ-APP-002; depends on: DEMO-REQ-REQ-001-001
- Actors: approver (demo.approver), requester (demo.requester)
- Setup:
  - [requester] sign in
  - [requester] open /requests/new
  - [requester] fill "Title" with <unique title>
  - [requester] fill "Amount" with "250"
  - [requester] click button "Create request" (remember page as subject)
- Steps:
  - [approver] sign in
  - [approver] open {{subject.path}}
  - [approver] fill "Reason" with <unique reason>
  - [approver] click button "Reject"
- Expected:
  - "the request status is "Rejected" and the reason is shown" — docs/requirements.md:105
    - check [approver] text <data.reason> is visible
    - check [approver] text "Rejected" is visible

### DEMO-REQ-APP-002-002 — Approver rejects with a reason — API rejects invalid input

- Status: READY · negative · P1 (risk 0.48)
- Requirements: DEMO-REQ-APP-002; depends on: DEMO-REQ-REQ-001-001
- Actors: approver (demo.approver), requester (demo.requester)
- Setup:
  - [requester] sign in
  - [requester] open /requests/new
  - [requester] fill "Title" with <unique title>
  - [requester] fill "Amount" with "250"
  - [requester] click button "Create request" (remember page as subject)
- Steps:
  - [approver] sign in
- Expected:
  - "rejecting without a reason returns HTTP 400 from `POST /api/requests/<id>/reject`" — docs/requirements.md:106
    - check [approver] POST /api/requests/{{subject.id}}/reject {"reason":""} → HTTP 400

### DEMO-REQ-AUTH-002-001 — Reject invalid credentials

- Status: READY · negative · P1 (risk 0.48)
- Requirements: DEMO-REQ-AUTH-002; depends on: —
- Actors: requester (demo.requester)
- Steps:
  - [requester] open /login
  - [requester] sign in with a wrong password
- Expected:
  - "the alert "Invalid username or password" is shown" — docs/requirements.md:34
    - check [requester] alert "Invalid username or password" is visible
  - "the user stays on `/login`" — docs/requirements.md:35
    - check [requester] URL path is /login

### DEMO-REQ-REQ-002-001 — Title is required

- Status: READY · negative · P1 (risk 0.48)
- Requirements: DEMO-REQ-REQ-002; depends on: —
- Actors: requester (demo.requester)
- Steps:
  - [requester] sign in
  - [requester] open /requests/new
  - [requester] fill "Title" with ""
  - [requester] fill "Amount" with "250"
  - [requester] click button "Create request" (remember page as subject)
- Expected:
  - "the alert "Title is required" is shown" — docs/requirements.md:64
    - check [requester] alert "Title is required" is visible
  - "no request is created" — docs/requirements.md:65
    - check [requester] GET /api/requests returns as many items as before

### DEMO-REQ-REQ-003-001 — Amount limits — amount 1 (accepted)

- Status: READY · boundary · P1 (risk 0.48)
- Requirements: DEMO-REQ-REQ-003; depends on: —
- Actors: requester (demo.requester)
- Steps:
  - [requester] sign in
  - [requester] open /requests/new
  - [requester] fill "Title" with <unique title>
  - [requester] fill "Amount" with "1"
  - [requester] click button "Create request" (remember page as subject)
- Expected:
  - "the request detail page shows the status "Pending"" — docs/requirements.md:76
    - check [requester] text "Pending" is visible

### DEMO-REQ-REQ-003-002 — Amount limits — amount 10000 (accepted)

- Status: READY · boundary · P1 (risk 0.48)
- Requirements: DEMO-REQ-REQ-003; depends on: —
- Actors: requester (demo.requester)
- Steps:
  - [requester] sign in
  - [requester] open /requests/new
  - [requester] fill "Title" with <unique title>
  - [requester] fill "Amount" with "10000"
  - [requester] click button "Create request" (remember page as subject)
- Expected:
  - "the request detail page shows the status "Pending"" — docs/requirements.md:76
    - check [requester] text "Pending" is visible

### DEMO-REQ-REQ-003-003 — Amount limits — amount 0 (rejected)

- Status: READY · boundary · P1 (risk 0.48)
- Requirements: DEMO-REQ-REQ-003; depends on: —
- Actors: requester (demo.requester)
- Steps:
  - [requester] sign in
  - [requester] open /requests/new
  - [requester] fill "Title" with <unique title>
  - [requester] fill "Amount" with "0"
  - [requester] click button "Create request" (remember page as subject)
- Expected:
  - "the alert "Amount must be a whole number between 1 and 10000" is shown" — docs/requirements.md:77
    - check [requester] alert "Amount must be a whole number between 1 and 10000" is visible

### DEMO-REQ-REQ-003-004 — Amount limits — amount 10001 (rejected)

- Status: READY · boundary · P1 (risk 0.48)
- Requirements: DEMO-REQ-REQ-003; depends on: —
- Actors: requester (demo.requester)
- Steps:
  - [requester] sign in
  - [requester] open /requests/new
  - [requester] fill "Title" with <unique title>
  - [requester] fill "Amount" with "10001"
  - [requester] click button "Create request" (remember page as subject)
- Expected:
  - "the alert "Amount must be a whole number between 1 and 10000" is shown" — docs/requirements.md:77
    - check [requester] alert "Amount must be a whole number between 1 and 10000" is visible

### DEMO-REQ-VIEW-001-001 — Viewer is read-only — the viewer sees all requests on `/`

- Status: NEEDS_REVIEW · happy · P1 (risk 0.42)
- Requirements: DEMO-REQ-VIEW-001; depends on: —
- Actors: viewer (demo.viewer)
- Steps:
  - [viewer] sign in
- Expected:
  - "the viewer sees all requests on `/`" — docs/requirements.md:124
    - check [viewer] MANUAL: the viewer sees all requests on `/`

### DEMO-REQ-APP-004-001 — Decision is visible in another tab

- Status: READY · state-transition · P2 (risk 0.27)
- Requirements: DEMO-REQ-APP-004; depends on: DEMO-REQ-REQ-001-001
- Actors: approver (demo.approver), requester (demo.requester)
- Setup:
  - [requester] sign in
  - [requester] open /requests/new
  - [requester] fill "Title" with <unique title>
  - [requester] fill "Amount" with "250"
  - [requester] click button "Create request" (remember page as subject)
- Steps:
  - [approver] sign in
  - [approver] open {{subject.path}}
  - [approver] click button "Approve"
- Expected:
  - "the requester sees the status "Approved" for that request in a second tab" — docs/requirements.md:135
    - then [requester] open {{subject.path}}
    - check [requester] text "Approved" is visible

### DEMO-REQ-REQ-004-001 — Requests are easy to find

- Status: NEEDS_REVIEW · happy · P2 (risk 0.21)
- Requirements: DEMO-REQ-REQ-004; depends on: —
- Actors: requester (demo.requester)
- Expected:
  - (none defined in the requirement)

## Routes not referenced by any requirement (no cases generated)

- GET /api/me
- ANY /api/requests/:param
- POST /api/test/reset
- GET /health
- POST /logout
- POST /requests
- ANY /requests/:param
- ANY /requests/:param/approve
- ANY /requests/:param/reject
- GET /requests/new

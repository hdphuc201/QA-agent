# Helpdesk — Requirements

Fixture requirements for the second QA Agent target app (`examples/helpdesk-app/server.mjs`), used to show that the pipeline is not tied to the first sample app. Not requirements of any real product.

## Roles

| Role     | Account key         | Can                                 |
| -------- | ------------------- | ----------------------------------- |
| customer | `helpdesk.customer` | open tickets, see own tickets       |
| agent    | `helpdesk.agent`    | see all tickets, close open tickets |
| auditor  | `helpdesk.auditor`  | see all tickets, read-only          |

## Access

### HD-REQ-ACC-001 — Log in

- Feature: Access
- Priority: P0
- Actors: customer
- Given: the user is on `/signin`
- When: the user signs in with a valid username and password
- Expected: the tickets page `/tickets` is shown with the heading "Tickets"
- Expected: the header shows "Logged in: Carol (customer)"

### HD-REQ-ACC-002 — Wrong passphrase

- Feature: Access
- Priority: P1
- Actors: customer
- Given: the user is on `/signin`
- When: the user signs in with a wrong password
- Expected: the alert "Wrong email or passphrase" is shown
- Expected: the user stays on `/signin`

### HD-REQ-ACC-003 — Anonymous users are sent to the login page

- Feature: Access
- Priority: P0
- Actors: anonymous
- When: an anonymous user opens `/tickets`
- Expected: the user is redirected to `/signin`
- Expected: `GET /api/tickets` without a session returns HTTP 401

## Tickets

### HD-REQ-TCK-001 — Open a ticket

- Feature: Tickets
- Priority: P0
- Actors: customer
- Given: the customer is signed in
- When: the customer submits "Open a ticket" with a subject and a severity of 2
- Expected: the ticket page shows the subject and the status "Open"
- Expected: the ticket appears on the tickets page `/tickets` with the status "Open"

### HD-REQ-TCK-002 — Severity limits

- Feature: Tickets
- Priority: P1
- Actors: customer
- Given: the customer is signed in
- When: the customer submits "Open a ticket" with a subject and the severity under test
- Boundary (accepted): severity 1, 4
- Boundary (rejected): severity 0, 5
- Expected (accepted): the ticket page shows the status "Open"
- Expected (rejected): the alert "Severity must be between 1 and 4" is shown
- Expected (rejected): no ticket is created

### HD-REQ-TCK-003 — Agent closes a ticket

- Feature: Tickets
- Priority: P0
- Actors: agent, customer
- Given: an open ticket created by the customer
- When: the agent opens the ticket and enters a resolution and clicks "Close ticket"
- Expected: the status is "Closed"
- Expected: the resolution is shown
- Expected: the customer sees the status "Closed" for that ticket
- Expected: `POST /api/tickets/<id>/close` without a resolution returns HTTP 400

### HD-REQ-TCK-004 — Only agents close tickets

- Feature: Tickets
- Priority: P0
- Actors: customer, auditor
- Given: an open ticket created by the customer
- When: a customer or auditor opens the ticket
- Expected: there is no "Close ticket" button
- Expected: `POST /api/tickets/<id>/close` returns HTTP 403

### HD-REQ-AUD-001 — Auditors are read-only

- Feature: Audit
- Priority: P1
- Actors: auditor
- Expected: the auditor has no "Open a ticket" link on `/tickets`
- Expected: `POST /api/tickets` returns HTTP 403 for the auditor

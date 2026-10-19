# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: approval.spec.ts >> Approval >> DEMO-REQ-APP-003-002 Only approvers can decide — as requester — API denies access
- Location: e2e\generated\approval.spec.ts:172:7

# Error details

```
Error: POST /api/requests/{{subject.id}}/approve as requester

expect(received).toBe(expected) // Object.is equality

Expected: 403
Received: 200
```

# Page snapshot

```yaml
- generic [active] [ref=f2e1]:
  - banner [ref=f2e2]:
    - navigation "Main" [ref=f2e3]:
      - link "Requests" [ref=f2e4] [cursor=pointer]:
        - /url: /
      - link "New request" [ref=f2e5] [cursor=pointer]:
        - /url: /requests/new
    - paragraph [ref=f2e6]: Signed in as Alice (requester)
    - button "Sign out" [ref=f2e8]
  - main [ref=f2e9]:
    - heading "QA title DEMO-REQ-APP-003-002 run-20261019T123259-bpwy-w1-7" [level=1] [ref=f2e10]
    - generic [ref=f2e11]:
      - term [ref=f2e12]: ID
      - definition [ref=f2e13]: REQ-9
      - term [ref=f2e14]: Amount
      - definition [ref=f2e15]: "250"
      - term [ref=f2e16]: Requested by
      - definition [ref=f2e17]: alice
      - term [ref=f2e18]: Status
      - definition [ref=f2e19]: Pending
```

# Test source

```ts
  99  |       tag: ['@P1', '@negative', '@DEMO-REQ-APP-002'],
  100 |       annotation: [
  101 |         { type: 'qa-case', description: 'DEMO-REQ-APP-002-002' },
  102 |         { type: 'requirement', description: 'DEMO-REQ-APP-002' },
  103 |       ],
  104 |     },
  105 |     async ({ actors }) => {
  106 |       const data = {
  107 |         title: unique('DEMO-REQ-APP-002-002', 'title'),
  108 |         reason: unique('DEMO-REQ-APP-002-002', 'reason'),
  109 |       };
  110 |       let subject: Subject = { path: '', id: '' };
  111 |       const requesterPage = await actors.page('requester');
  112 |       await test.step('setup (from DEMO-REQ-REQ-001-001)', async () => {
  113 |         await actors.login('requester');
  114 |         await requesterPage.goto('/requests/new');
  115 |         await requesterPage.getByLabel('Title', { exact: true }).fill(data.title);
  116 |         await requesterPage.getByLabel('Amount', { exact: true }).fill('250');
  117 |         await requesterPage.getByRole('button', { name: 'Create request', exact: true }).click();
  118 |         await requesterPage.waitForLoadState();
  119 |         subject = subjectOf(requesterPage);
  120 |       });
  121 |       await test.step('steps', async () => {
  122 |         await actors.login('approver');
  123 |       });
  124 |       await test.step('expect: rejecting without a reason returns HTTP 400 from `POST /api/requests/<id>/reject` (docs/requirements.md:106)', async () => {
  125 |         {
  126 |           const res = await (
  127 |             await actors.request('approver')
  128 |           ).fetch(`/api/requests/${subject.id}/reject`, { method: 'POST', data: { reason: '' } });
  129 |           expect(res.status(), 'POST /api/requests/{{subject.id}}/reject as approver').toBe(400);
  130 |         }
  131 |       });
  132 |     },
  133 |   );
  134 | 
  135 |   test(
  136 |     'DEMO-REQ-APP-003-001 Only approvers can decide — as requester',
  137 |     {
  138 |       tag: ['@P0', '@rbac', '@DEMO-REQ-APP-003'],
  139 |       annotation: [
  140 |         { type: 'qa-case', description: 'DEMO-REQ-APP-003-001' },
  141 |         { type: 'requirement', description: 'DEMO-REQ-APP-003' },
  142 |       ],
  143 |     },
  144 |     async ({ actors }) => {
  145 |       const data = { title: unique('DEMO-REQ-APP-003-001', 'title') };
  146 |       let subject: Subject = { path: '', id: '' };
  147 |       const requesterPage = await actors.page('requester');
  148 |       await test.step('setup (from DEMO-REQ-REQ-001-001)', async () => {
  149 |         await actors.login('requester');
  150 |         await requesterPage.goto('/requests/new');
  151 |         await requesterPage.getByLabel('Title', { exact: true }).fill(data.title);
  152 |         await requesterPage.getByLabel('Amount', { exact: true }).fill('250');
  153 |         await requesterPage.getByRole('button', { name: 'Create request', exact: true }).click();
  154 |         await requesterPage.waitForLoadState();
  155 |         subject = subjectOf(requesterPage);
  156 |       });
  157 |       await test.step('steps', async () => {
  158 |         await requesterPage.goto(subject.path);
  159 |       });
  160 |       await test.step('expect: no "Approve" button is shown to them (docs/requirements.md:115)', async () => {
  161 |         await expect(
  162 |           requesterPage.getByRole('button', { name: 'Approve', exact: true }),
  163 |         ).toHaveCount(0);
  164 |       });
  165 |       await test.step('expect: the request stays "Pending" (docs/requirements.md:117)', async () => {
  166 |         await requesterPage.goto(subject.path);
  167 |         await expect(requesterPage.getByText('Pending', { exact: true }).first()).toBeVisible();
  168 |       });
  169 |     },
  170 |   );
  171 | 
  172 |   test(
  173 |     'DEMO-REQ-APP-003-002 Only approvers can decide — as requester — API denies access',
  174 |     {
  175 |       tag: ['@P0', '@rbac', '@DEMO-REQ-APP-003'],
  176 |       annotation: [
  177 |         { type: 'qa-case', description: 'DEMO-REQ-APP-003-002' },
  178 |         { type: 'requirement', description: 'DEMO-REQ-APP-003' },
  179 |       ],
  180 |     },
  181 |     async ({ actors }) => {
  182 |       const data = { title: unique('DEMO-REQ-APP-003-002', 'title') };
  183 |       let subject: Subject = { path: '', id: '' };
  184 |       const requesterPage = await actors.page('requester');
  185 |       await test.step('setup (from DEMO-REQ-REQ-001-001)', async () => {
  186 |         await actors.login('requester');
  187 |         await requesterPage.goto('/requests/new');
  188 |         await requesterPage.getByLabel('Title', { exact: true }).fill(data.title);
  189 |         await requesterPage.getByLabel('Amount', { exact: true }).fill('250');
  190 |         await requesterPage.getByRole('button', { name: 'Create request', exact: true }).click();
  191 |         await requesterPage.waitForLoadState();
  192 |         subject = subjectOf(requesterPage);
  193 |       });
  194 |       await test.step('expect: `POST /api/requests/<id>/approve` returns HTTP 403 for them (docs/requirements.md:116)', async () => {
  195 |         {
  196 |           const res = await (
  197 |             await actors.request('requester')
  198 |           ).fetch(`/api/requests/${subject.id}/approve`, { method: 'POST' });
> 199 |           expect(res.status(), 'POST /api/requests/{{subject.id}}/approve as requester').toBe(403);
      |                                                                                          ^ Error: POST /api/requests/{{subject.id}}/approve as requester
  200 |         }
  201 |       });
  202 |     },
  203 |   );
  204 | 
  205 |   test(
  206 |     'DEMO-REQ-APP-003-003 Only approvers can decide — as viewer',
  207 |     {
  208 |       tag: ['@P0', '@rbac', '@DEMO-REQ-APP-003'],
  209 |       annotation: [
  210 |         { type: 'qa-case', description: 'DEMO-REQ-APP-003-003' },
  211 |         { type: 'requirement', description: 'DEMO-REQ-APP-003' },
  212 |       ],
  213 |     },
  214 |     async ({ actors }) => {
  215 |       const data = { title: unique('DEMO-REQ-APP-003-003', 'title') };
  216 |       let subject: Subject = { path: '', id: '' };
  217 |       const requesterPage = await actors.page('requester');
  218 |       const viewerPage = await actors.page('viewer');
  219 |       await test.step('setup (from DEMO-REQ-REQ-001-001)', async () => {
  220 |         await actors.login('requester');
  221 |         await requesterPage.goto('/requests/new');
  222 |         await requesterPage.getByLabel('Title', { exact: true }).fill(data.title);
  223 |         await requesterPage.getByLabel('Amount', { exact: true }).fill('250');
  224 |         await requesterPage.getByRole('button', { name: 'Create request', exact: true }).click();
  225 |         await requesterPage.waitForLoadState();
  226 |         subject = subjectOf(requesterPage);
  227 |       });
  228 |       await test.step('steps', async () => {
  229 |         await actors.login('viewer');
  230 |         await viewerPage.goto(subject.path);
  231 |       });
  232 |       await test.step('expect: no "Approve" button is shown to them (docs/requirements.md:115)', async () => {
  233 |         await expect(viewerPage.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(
  234 |           0,
  235 |         );
  236 |       });
  237 |       await test.step('expect: the request stays "Pending" (docs/requirements.md:117)', async () => {
  238 |         await viewerPage.goto(subject.path);
  239 |         await expect(viewerPage.getByText('Pending', { exact: true }).first()).toBeVisible();
  240 |       });
  241 |     },
  242 |   );
  243 | 
  244 |   test(
  245 |     'DEMO-REQ-APP-003-004 Only approvers can decide — as viewer — API denies access',
  246 |     {
  247 |       tag: ['@P0', '@rbac', '@DEMO-REQ-APP-003'],
  248 |       annotation: [
  249 |         { type: 'qa-case', description: 'DEMO-REQ-APP-003-004' },
  250 |         { type: 'requirement', description: 'DEMO-REQ-APP-003' },
  251 |       ],
  252 |     },
  253 |     async ({ actors }) => {
  254 |       const data = { title: unique('DEMO-REQ-APP-003-004', 'title') };
  255 |       let subject: Subject = { path: '', id: '' };
  256 |       const requesterPage = await actors.page('requester');
  257 |       await test.step('setup (from DEMO-REQ-REQ-001-001)', async () => {
  258 |         await actors.login('requester');
  259 |         await requesterPage.goto('/requests/new');
  260 |         await requesterPage.getByLabel('Title', { exact: true }).fill(data.title);
  261 |         await requesterPage.getByLabel('Amount', { exact: true }).fill('250');
  262 |         await requesterPage.getByRole('button', { name: 'Create request', exact: true }).click();
  263 |         await requesterPage.waitForLoadState();
  264 |         subject = subjectOf(requesterPage);
  265 |       });
  266 |       await test.step('steps', async () => {
  267 |         await actors.login('viewer');
  268 |       });
  269 |       await test.step('expect: `POST /api/requests/<id>/approve` returns HTTP 403 for them (docs/requirements.md:116)', async () => {
  270 |         {
  271 |           const res = await (
  272 |             await actors.request('viewer')
  273 |           ).fetch(`/api/requests/${subject.id}/approve`, { method: 'POST' });
  274 |           expect(res.status(), 'POST /api/requests/{{subject.id}}/approve as viewer').toBe(403);
  275 |         }
  276 |       });
  277 |     },
  278 |   );
  279 | 
  280 |   test(
  281 |     'DEMO-REQ-APP-004-001 Decision is visible in another tab',
  282 |     {
  283 |       tag: ['@P2', '@state-transition', '@DEMO-REQ-APP-004'],
  284 |       annotation: [
  285 |         { type: 'qa-case', description: 'DEMO-REQ-APP-004-001' },
  286 |         { type: 'requirement', description: 'DEMO-REQ-APP-004' },
  287 |       ],
  288 |     },
  289 |     async ({ actors }) => {
  290 |       const data = { title: unique('DEMO-REQ-APP-004-001', 'title') };
  291 |       let subject: Subject = { path: '', id: '' };
  292 |       const requesterPage = await actors.page('requester');
  293 |       const approverPage = await actors.page('approver');
  294 |       const requesterTab2 = await actors.newTab('requester');
  295 |       await test.step('setup (from DEMO-REQ-REQ-001-001)', async () => {
  296 |         await actors.login('requester');
  297 |         await requesterPage.goto('/requests/new');
  298 |         await requesterPage.getByLabel('Title', { exact: true }).fill(data.title);
  299 |         await requesterPage.getByLabel('Amount', { exact: true }).fill('250');
```
# Shortened directory names

Playwright names failure folders after the full test title. Two of these paths were 166 characters long. Cloned under `~/.claude/plugins/marketplaces/…`, they broke the Windows 260-character limit, and the P9 GitHub install smoke failed on them. The folders were renamed; their content is unchanged.

| Folder                  | Original Playwright folder                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `viewer-api-denied/`    | `approval-Approval-DEMO-REQ-7ce5d--viewer-—-API-denies-access-chromium/` (DEMO-REQ-APP-003-004)        |
| `requester-api-denied/` | `approval-Approval-DEMO-REQ-ac926-quester-—-API-denies-access-chromium/` (DEMO-REQ-APP-003-002)        |

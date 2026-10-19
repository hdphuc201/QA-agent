# Release process, compatibility and checklists

QA Agent is distributed as a Claude Code plugin from this Git repository (marketplace `qa-agent`, plugin `qa-agent@qa-agent`). A release is a commit on `main` with a version tag. **Tags, pushes of tags, GitHub releases and any publishing happen only when the project owner explicitly asks for them.**

## Release steps

1. Set the same version in `package.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. Add a `## <version>` section to `CHANGELOG.md`.
2. Rebuild and verify:
   - `npm run bundle`
   - `node scripts/quality-gate.mjs P9` (all checks)
   - `node scripts/smoke/install-smoke.mjs` (clean clone → isolated install → installed engine runs a fresh project)
3. `node scripts/release-dry-run.mjs` must print `DRY-RUN OK`. It checks a clean tree, version agreement, bundle freshness, plugin validation, a secret/personal-path scan of every tracked file and dependency licenses, and records the release archive digest. It does not tag or publish anything.
4. Commit and push `main`; CI must be green.
5. **Owner only:** `git tag v<version>` and `git push origin v<version>`, then optionally a GitHub release with the CHANGELOG section.
6. After the tag: `node scripts/smoke/install-smoke.mjs --github hdphuc201/QA-agent` (install from GitHub).

Users update with `claude plugin marketplace update qa-agent` and `claude plugin update qa-agent@qa-agent`.

## Compatibility matrix (verified)

| Component                        | Verified                                                                                                    | Where                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| OS                               | Windows 11 (local development, all live evidence); Ubuntu `ubuntu-latest` and Windows `windows-latest` (CI) | `evidence/`, `evidence/P9/ci-run-*.log`       |
| Node.js                          | 22.15.0 (bundle target: Node 22)                                                                            | local, CI                                     |
| Claude Code                      | 2.1.71 (manifest fields, hooks protocol, skills, agent, MCP)                                                | local, CI `plugin validate`                   |
| Playwright Test                  | 1.63.0 (target project dependency)                                                                          | local, CI, install smoke                      |
| Playwright MCP                   | 0.0.83 (pinned in `.mcp.json`)                                                                              | local, CI                                     |
| Browsers                         | Chrome channel and Chromium; Firefox 155 (build 1543); WebKit 26.6 (build 2359)                             | cross-browser tests, CI                       |
| Target apps                      | 2 fixture apps (`examples/sample-app`, `examples/helpdesk-app`)                                             | integration suite                             |
| TypeScript in the target project | optional (strict type-check of generated code when present)                                                 | install smoke (absent), integration (present) |

Not verified: macOS, Node 24, other Claude Code versions, real production-like applications (SPAs with client-side routing, SSO logins, MFA).

## Licensing checklist

- [x] Direct dependencies are permissive: zod, esbuild, eslint, prettier and typescript-eslint (MIT); `@playwright/test`, `@playwright/mcp` and TypeScript (Apache-2.0). Checked by the dry-run.
- [x] The bundle contains zod (MIT); its notice is kept in the bundle header and legal comments.
- [ ] **Owner decision:** the project license. There is no `LICENSE` file, and `package.json` is `private`. Until a license is chosen, the public repository is "all rights reserved" by default.

## Security checklist

- [x] Threat model with controls mapped to tests (`docs/THREAT_MODEL.md`, ADR 0007)
- [x] No credentials in config (schema rejects them), command lines (hook), artifacts (scrubber) or reports (masking)
- [x] Generated tests confined to `allowedOrigins` at run time; production refused without owner approval; destructive steps blocked by default
- [x] Failure-analyzer agent read-only (contract test); skills user-invoked only
- [x] Secret / personal-path scan of the tracked tree (dry-run) and of every commit
- [x] CI uses no secrets; workflow permissions `contents: read`
- [ ] Owner, optional: live proof of the credential hook in a Claude session (`npm run smoke:claude-hook`)

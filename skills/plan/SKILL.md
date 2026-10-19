---
description: "QA Agent test planning. Turns the target project's requirement documents and the discovery project map into a traceable, risk-ranked test matrix (READY / NEEDS_REVIEW / BLOCKED) under .qa-agent/plan/. Use when the user asks to plan, design or list test cases."
argument-hint: "[scope]"
disable-model-invocation: true
---

# QA Agent — plan

Status: **implemented (P3)**. Arguments: $ARGUMENTS

1. The project needs `.qa-agent/config.json` with `docsPaths` pointing to the requirement documents. Run `/qa-agent:discover` first so that forms, links and buttons can be resolved; without a project map most cases end up `NEEDS_REVIEW`.
2. Run the deterministic planner with the Bash tool (plugin root `${CLAUDE_PLUGIN_ROOT}`; if not substituted, use the directory containing this plugin's `.claude-plugin/plugin.json`):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/qa-agent.mjs" plan --project "<project root>"
   ```

3. Summarise `.qa-agent/plan/test-plan.md`: cases per status and category, the highest-risk cases, `NEEDS_REVIEW` / `BLOCKED` cases with their blockers, requirements without READY cases, and routes no requirement mentions.
4. Rules you must keep:
   - Expected results come only from `Expected` lines of the requirements (each case quotes them with file:line). Never add, edit or "improve" an expected result, and never derive one from the current UI.
   - Do not mark a case READY or edit `test-plan.json` by hand. To make a `NEEDS_REVIEW` case runnable, propose a requirement wording change (format: `docs/REQUIREMENTS_FORMAT.md` in the plugin) for the owner to approve, then re-run the planner.
   - Only READY cases go to `/qa-agent:generate`.

If `$ARGUMENTS` names a scope (feature or requirement IDs), filter the summary to it; the plan file always covers all requirements.

End with the line `QA-AGENT-SKILL: plan | status=implemented | phase=P3`.

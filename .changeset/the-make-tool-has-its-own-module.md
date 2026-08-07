---
"@vendoai/apps": patch
---

Three of this block's densest functions are decompositions now. The agent-tool registry's `execute` is a dispatcher: `vendo_make` and its two routes moved to `make-tool.ts`, the three `vendo_apps_data_*` doors to `data-tools.ts`, and the argument checks both share to `tool-args.ts`. `validatePlan` hands its steps rules to a `stepsIssues` collector beside the `scheduleIssues` one it already had, and the Claude session loop reads its `query()` options and its assistant-message scan from two named siblings — siblings, not modules, because `dist/claude-turn.js` is copied verbatim into the box image and has no relative imports to give them. No public surface changed, no behaviour changed, and no test changed.

---
"@vendoai/apps": major
"@vendoai/harnesses": minor
---

One Claude Code integration, and automation authoring gets its own door

The box carried **two** Claude Agent SDK loops: the conversational session door
(`claude-turn.mjs`, the same module `machine: "local"` runs on a host) and a
bespoke one-shot runner behind `/agent/task`. The duplicate is deleted. The
supervisor's task door now drives the SAME `claude-turn.mjs` the session door
does — one runner, two doors, three callers — keeping what only the task door
needs: the box conventions the agent builds against, and the structured result
the host polls for. That result now arrives as `/app/.vendo/report.json`, which
the agent writes and the supervisor reads, instead of an in-process MCP tool.
**The control-port protocol did not change**; nothing outside the box needed
edits.

Escalation now means exactly two rungs: the screen agent, and the box.
`steps`/`agentic` are no longer branches of the server lane — authoring an
automation never needed a machine, so it is its own door:

```ts
await apps.automation.author(
  { appId, instruction: "email me the unpaid invoices every Friday", mode: "steps" },
  ctx,
);
// → { ok: true, document, triggerId, armed } | { ok: false, issues }
```

The planner, the trigger-id rules, the results-board rewire and the arming are
**unchanged** — `planAutomation` and its lane moved from
`generation/lanes.ts` to `server/automation/{plan,lane}.ts` verbatim. An
escalated plan that asks for an automation is routed to the same door, so both
ways in land, arm and audit identically.

**Behavior fix:** `create` and `edit` no longer disagree about escalation.
`create` used to refuse EVERY escalation on a deployment with no sandbox while
`edit` refused only a box — so an automation you could ask for by editing an
app you could not ask for by making one. Both now gate on the one expression
(`escalationNeedsMachine`), and only the box rung needs a machine.

**Migration:** `AppsRuntime` gains a required `automation` slot (a test double
implementing the interface by hand must add it). No import path changed.

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
the host polls for.

**Box boundary — the one behavioral change.** That structured result now arrives
as a FILE: the agent writes `/app/.vendo/report.json` and the supervisor reads
it back, where it used to call an in-process `report_done` MCP tool. The shared
runner's only MCP server is the host's own door, and a box task has none, so
the report rides the one channel a box task and its supervisor already share.
The JSON is the same shape it always was (`ok`, `summary`, `filesChanged`,
`testsRun`, `fns?`, `servesUi?`) and it is still treated as DATA host-side —
nothing in it can approve or authorize anything. **If you maintain a custom box
image or your own in-box agent, this is the line to change**: end the task by
writing that file instead of calling a tool. **The control-port protocol itself
did not change** — `/agent/task` still answers `202 {taskId}` and
`/agent/task/<id>` still answers `{status, result?, log}`, so nothing outside
the box needed edits.

Escalation now means exactly two rungs: the screen agent, and the box.
Authoring an automation never needed a machine, so it is its own door:

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

**`<Server kind="steps">` and `<Server kind="agentic">` both still exist and
still work — nothing was removed from the plan dialect.** What changed is where
they lead: they are no longer *escalation kinds* (branches of the server lane
that could reach for a machine), they are the escalating agent's signal INTO
the automation door. A plan that declares either authors exactly the automation
it always did. `steps` remains the deterministic mode — a fixed step pipeline
with no model call per firing — and `agentic` the judgment-per-run mode. Only
`kind="box"` still means a machine, and it is now the only rung the ladder has.

**Behavior fix:** `create` and `edit` no longer disagree about escalation.
`create` used to refuse EVERY escalation on a deployment with no sandbox while
`edit` refused only a box — so an automation you could ask for by editing an
app you could not ask for by making one. Both now gate on the one expression
(`escalationNeedsMachine`), and only the box rung needs a machine.

**Migration:** `AppsRuntime` gains a required `automation` slot (a test double
implementing the interface by hand must add it). No import path changed.

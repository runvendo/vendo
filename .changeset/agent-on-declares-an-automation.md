---
"@vendoai/agents": minor
"@vendoai/apps": minor
---

Two doors author an automation now: `agent.on(...)` in your own code, and `vendo_automate` when a person asks in chat.

`support.on(when, task, options?)` is a DECLARATION, never a store write — it validates where you wrote it and `createVendo` reconciles it at boot. All five `When` shapes:

```ts
support.on("0 9 * * 1", "summarize the week and email ops");
support.on({ every: "1d" }, "refresh credit scores");
support.on({ at: "2026-09-01T09:00:00Z" }, "send the launch note");
support.on({ event: "payment.failed" }, "triage and notify the user");
support.on({ webhook: "stripe" }, "reconcile the payout");
support.on("0 2 * * *", "rebuild the digest", { id: "nightly-digest" });
```

A bad cron throws at module load, not at 2am, with what, why, a did-you-mean you can paste and the docs link. The code is the consent, so a redeploy reconciles: new → created, edited → a new identity with the old one disarmed, deleted from your source → disarmed (never deleted, so its run history survives). Identity defaults to `hash(when + task + agent)`, so editing the cron or the words MINTS a new automation — pass `id` to keep one across an edit. A `disable()` a person did stamps `disarmedBy: "user"`, and that kill switch survives every redeploy.

`@vendoai/agents` newly exports `agentAutomations`, `agentAutomationPlan` and `OnOptions`. The plan is built here and applied only by the engine's own internal reconcile: this package may not import `@vendoai/automations`, so there is no second write path to disagree with the first. Agent names ride through verbatim — two agents claiming one name produce two declarations both claiming that runner name, because collapsing them here would hide a collision the runner map has to throw on at startup.

`vendo_automate` is the chat door — a schedule with nothing to build. It takes `{ task, when?, agent?, timezone? }` and carries **no app argument of any kind**, because a record has no app slot to fill. `vendo_make` still arms the schedule half of a compound ask ("build me the board and refresh it every Monday") and does it by calling the same one create operation, so the two cannot drift into arming differently. The `vendo.json` manifest fold-in is a reconcile through the same core helper: a changed cron replaces its own record under the same identity, a schedule dropped from the manifest disarms its own, an unchanged manifest touches nothing, and two schedules that collapse to one identity are refused out loud rather than last-wins.

**Breaking, and the reason your app writes may start failing:** every triggers-in-documents path is gone rather than shimmed — `app-validation`, the edit journal, interchange, persistence, the runtime types and the write surface all lost their trigger halves. An app document that still carries `triggers` no longer arms anything. What an app may hold instead is an optional `automations: string[]`, maintained by this layer alone (the compound flow and the manifest fold-in, nowhere else) and resolved on read. Deleting the app does NOT stop its automation: the automation fires, reaches for the tool its task named, and fails loudly with a `not-found` that becomes a terminal error run row.

One misuse hole closed on the way past. `vendo_automate`'s `when` now requires exactly one of `every` / `at` / `event` / `webhook` (or a bare cron string) and refuses the rest, naming what it got and where the shapes are written down. An object naming none of them used to become `{ kind: "external", connector: undefined }` — an automation nothing could ever trigger, reported to its owner as armed.

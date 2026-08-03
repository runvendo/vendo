# The automations pack

**2026-07-30.** Companion to `2026-07-30-embedded-agent-architecture-design.md`
(the architecture — read it first; §5 packs, §12 consent, §13 sponsorship) and
`2026-07-30-build-contract.md` (frozen shapes). This file designs `automations()`
as a pack on the public four-slot interface. Decided with Yousef 2026-07-30
(two rounds): the outbox is first-class · a judgment firing is one harness run ·
**fully agentic is the default authoring mode** · steps gain agent steps
(judgment islands) · consent declares at authoring and accretes at runtime.

## 1. What an automation is

Unchanged: **an app with a trigger.** The trigger — *when* it fires and *what*
it does — lives in the app document, is edited like any file, and joins the
app-intent hash (§12), so any change to it invalidates the grant set and
re-asks the delta. There is no second document kind and no separate automation
store; `vendo_apps` rows with a `trigger` field remain the truth.

The dividing line, applied here:

| Platform core (lifecycle) | The pack (content over it) |
|---|---|
| tick loop + schedule cursors | `schedule`, run listing, cancel, `prepare` tools |
| webhook ingestion + signatures | the authoring skill |
| run records + the runs store | the checks |
| grant sets, enable atomicity | automation card, run history, ready-to-send card |
| sponsorship + adoption | — |

Third-party packs wanting recurring behavior call the same `schedule` tool
through the same guard; `automations()` holds no privileged API. The
machine-app manifest scheduler (`packages/apps/src/schedules.ts`) is a separate
lifecycle and is untouched by this design.

## 2. The run model

The spectrum: **fully agentic (default) → steps with judgment islands →
pure steps (free).** The skill leads with agentic; steps is the optimization
for stable recipes, not the entry point.

```ts
type RunModel =
  | { kind: "agentic"; prompt: string;              // THE DEFAULT: a prompt on a clock
      tools?: string[];                             // best-effort declaration (consent, §8)
      budget?: { maxToolCalls?: number } }
  | { kind: "steps"; steps: Step[] };               // the free deterministic path

type Step =
  | { id: string; tool: string;                     // tool step (as shipped)
      args?: Record<string, string>; if?: string; forEach?: string }
  | { id: string; agent: string;                    // agent step: a judgment island
      input?: string; if?: string };                // input = jsonata over {event, steps}
```

- **`agentic`** keeps its persisted tag (additive law) but its semantics are
  replaced: a firing is **one non-interactive harness run** on the wired
  harness — `turn.interactive = false`, the automation's workspace mounted.
  The private `config.runner` seam is deleted; orchestration inside the run
  (subagents, depth) is the harness's business.
- **An agent step** is one bounded harness run whose answer lands in
  `steps.<id>` exactly like a tool result; `input`'s evaluated value is handed
  to it alongside its job text. The fetches and the sends around it stay
  deterministic and free — only the judgment costs tokens.
- **What any harness run (agentic or agent step) is projected:** every
  read-risk tool (reads are silent by law), the workspace, `prepare`, and the
  vendo verbs. Write-risk tools pass the guard only with a standing grant —
  granted upfront from the declaration or accreted via the failure card (§8).
  There is no capability cap from the declaration itself; the guard is the cap.
- **Never projected into any automation run, either kind:** destructive and
  external-effect tools (money, messages to humans, deletes — the §12
  mechanical two-vote rule). Not with a limit, not with an override. The
  outbox (§4) is the replacement.
- **Steps ids are names, not indexes**, because steps reference each other
  (`steps.overdue.items`) and automations are edited like files — a positional
  reference silently reads the wrong step's data after any insert; a name
  survives every edit. Bare identifiers, unique per plan (the shipped rule).
- **Park is dead here.** A missing grant or a needed approval fails the run
  loudly with the §3 failure card ("needs approval for X — Grant & re-run");
  re-run is a fresh run against live data, safe because effects are ledgered.
  The engine's internal step-resume stays as shipped implementation detail and
  is never extended.

## 3. Tools

Four tools, global names as authored (boot-collision is the namespacing; host
tools carry the product slug so they can't collide):

```ts
// schedule — set or change when an automation fires and what it runs.
// A façade edit of the app document's trigger field + validate: the file
// stays the only truth, and a direct file edit lands at the same commit
// hook with the same checks. Never arms anything — enable is a human card.
schedule({
  appId: string,
  on:  { kind: "schedule", cron?: string, every?: string, at?: string }
     | { kind: "host-event", event: string }
     | { kind: "external", connector: string },   // connect-required flow as today
  run: RunModel,
}) → { appId: string, enabled: boolean }          // enabled: false until the card is tapped

// automation_runs — run history, consumer-shaped, for "why did last night fail?"
automation_runs({ appId: string, status?: RunStatus, cursor?: string })
  → { runs: RunRecord[], cursor?: string }

// automation_cancel — stop a running or grant-blocked run.
automation_cancel({ runId: string }) → { stopped: true }

// prepare — record an intended action WITHOUT executing it (§4).
prepare({
  tool: string,          // the real tool the human's tap will execute
  args: Json,            // validated against the tool's schema NOW, not at 8am
  line: string,          // consumer voice, material arguments required
}) → { preparedId: string }
```

Risk labels: `schedule` and `prepare` are `write`; `automation_runs` is `read`;
`automation_cancel` is `write`. Enable/disable is deliberately **not a tool**:
arming an automation is the consent moment, and consent is a tap on a card.

## 4. The outbox (prepare-then-send, first-class)

The §12 law's other half, shipped once instead of re-invented per automation.

- **Rows** ride the existing records machinery in the engine-owned collection
  `automations:outbox`, subject-partitioned:

```ts
interface PreparedAction {
  id: string;                 // prep_…
  appId: string;
  runId: string;
  tool: string;
  args: Json;                 // schema-validated at prepare time
  line: string;               // "Reminder to Acme — $1,400 overdue"
  preparedAt: string;
  status: "ready" | "sent" | "dismissed" | "superseded";
  sentAt?: string;
}
```

- **`prepare` validates eagerly.** Tool exists, args parse against its input
  schema, `line` is non-empty — a typo fails the 2am run (loudly, fixable),
  never the 8am tap.
- **Superseding:** a new run's first `prepare` flips the app's previous
  `ready` items to `superseded`. Each firing owns the queue; drafts never
  pile up across mornings. Items are snapshots — the tap sends what was
  prepared; if reality changed, she dismisses.
- **The card is the confirm.** The shipped ready-to-send component renders one
  line per item with material arguments, per-item send/dismiss, and
  **[Send all]**. It already meets §12 completeness (one line per action, the
  exact tool and args one tap away), so the tap on it IS the §12 interactive
  confirm — no second popup. The tap mints one approval covering exactly the
  listed item ids; each call executes through the guard, present-voiced, with
  that approval attached and `idempotencyKey = item id`, so a double-tap
  cannot double-send (effect ledger). Nothing not listed can ride the tap.
- **Consent disclosure, not grants:** prepare targets need no standing grant —
  the send is interactive, as her, confirmed. But the enable card discloses
  them in their own section ("it will prepare, for you to send: emails"),
  and they join the intent hash via the run body.
- **The home** follows the §3 failure-card law: the app's own surface, a
  launcher badge count, and the host notification hook ("12 reminders ready").

## 5. The skill

One authoring skill, `authoring-automations` (SKILL.md, `/host/skills/`),
read inline (no subagent advice — it's a procedure, not a big loud job):

- **Default to agentic**: a clear prompt on a clock supports everything. Drop
  to steps when every firing does the same thing (steps cost nothing at
  night); use an agent step when a stable recipe has one judgment moment.
  After a few identical agentic runs, offering to compile the pattern down to
  steps is good citizenship — cheaper and more predictable for the user.
- **Declare what you know** (`tools`): you just wrote the automation, so name
  the writes you expect — that becomes the one upfront card. What you miss
  isn't fatal; it accretes (§8). Never declare wide "just in case" — a
  whole-registry declaration is rejected, and every name you add is a line the
  user must read.
- **The steps dialect**: jsonata args over `{event, steps, item}`, bare-
  identifier step ids, publish-derives-from-a-prior-read (today's planner
  contract, moved here).
- **Prepare-then-send is THE pattern** for anything irreversible: read, decide,
  `prepare` each action with a line a human can judge at a glance, publish a
  summary. Never ask for a send/pay/delete tool directly — the checks will
  refuse it.
- **Publish results** to a records collection the app's board reads; a run
  that shows nothing on the board didn't happen, as far as the user can tell.
- **Consumer voice throughout**: the automation's name says what it does in
  the user's words; schedule phrased as the user said it ("every Monday
  morning"), stored as cron; lines carry the material arguments.

## 6. Checks

The floor that holds whatever the harness did (fires at the same app-commit
hook as everything else):

Fact (mechanical, instant):
1. Trigger parses and can fire — cron valid per croner, `every` > 0, `at` is
   ISO (today's `validateTrigger`, relocated).
2. Every named tool exists: tool steps, the declared `tools` list, prepare
   targets referenced by the run body.
3. **No destructive or external-effect tool as a step tool or declared tool**
   (two-vote rule: AI risk label AND method/verb shape; disagreement =
   destructive). Prepare targets are exempt — that's the pattern.
4. A declared `tools` list, when present, is not the whole registry (§12:
   whole-registry declarations are rejected, not bundled). No declaration is
   legal — accretion covers it.
5. A steps publish derives from a prior step's output or the event, never
   hand-typed (today's planner rule; an agent step's output counts as derived).
6. A declared results collection is actually written by some step.

Judgment (joins the reviewer rubric):
- The name and description say what the automation does, in the user's words.
- The run body matches the user's ask; an agent step's job text is
  self-contained (the 2am run sees only it plus its input).
- Prepared-action lines carry the material arguments (an argument-free line
  is a finding, same as jargon).

## 7. Components

Three, in today's catalog vocabulary (`{ component, description, props }`):

- **Automation card** — what/when in plain words, on/off, "waiting on N
  permissions" (rendered from the pending-captures projection, reload-safe),
  the enable card entry point, and the optional **[Test it now]** run (§8).
- **Run history** — a render over audit rows, no new machinery. A
  non-technical user reading a 2am run sees: "Ran at 2:00 this morning ·
  Checked your invoices · Prepared 12 reminders · Ready to send", and on
  failure: "Couldn't finish — it needs permission to read invoices ·
  [Grant & re-run]" with the skipped-run count. Verbs and titles, never tool
  names; errors consumer-voiced.
- **Ready to send** — the outbox card (§4).

## 8. Consent: declare at authoring, accrete at runtime

Both flows are §12/§13 machinery; the pack renders them. The consent posture,
end to end:

- **Reads are silent, always** (§12 law) — an automation investigates freely.
- **Writes it declared** → one pre-filled enable card, atomic with its grant
  set, never armed with permissions pending. The agent authors the
  declaration (it wrote the automation; it knows), so the normal case is one
  honest card at enable. Sections: *while you're away it can* (the standing
  grants) · *it will prepare, for you to send* (disclosure, no grant).
- **Writes it didn't declare** → the run fails loudly at the guard with the
  §3 card ("needs permission to update invoices — Grant & re-run"); the grant
  is standing, the card covers only that delta, re-run is fresh and
  ledger-safe. Accretion is the backstop, not the plan.
- **Irreversible** → never granted, never asked: the outbox (§4).
- **[Test it now]** is an optional confidence run offered at enable — she's
  present, so any missing write asks inline as a normal popup and each yes
  becomes a standing grant. It is a convenience that front-loads accretion,
  never the consent mechanism.
- **Adopt** — sponsorship invalidated (sponsor left, grants invalidated, or
  anyone else edited the app) → the automation stops and asks editors+ to
  adopt with one card approving its reads and writes as themselves. The
  automation card labels its window ("runs with Dana's access").

**Architecture amendment required (routed to the orchestrator, not edited
locally):** §12's first bullet ("permissions beforehand, in one honest card")
softens to *"beforehand when declared; accrete-on-first-need otherwise via the
§3 failure card."* The accretion path is machinery §3 already ratified; this
records that it is now a sanctioned consent path, not only a failure mode.

## 9. What this deletes

- `config.runner` and the private agentic loop (`runAgentic`'s model half) —
  replaced by one harness run.
- `packages/apps/src/automation-plan.ts` — the single-call planner. The skill
  + the wired harness author automations now; its validation rules survive as
  §6 checks, its prompt knowledge as §5 skill content.
- Agentic enable's every-descriptor capture — replaced by declared-or-accreted
  grants.
- Park for anything new (engine-internal step-resume grandfathered, as shipped).

## 10. Open

- Exact wire/props shapes for the three components — display & remix design
  pass (§16 of the architecture), where the cards get styled with mockups.
- Whether `prepare` batches want an expiry independent of superseding (e.g. a
  weekly automation's Monday drafts on Friday). Deferred until a real
  automation shows the need; superseding covers the recurring case.
- Agent-step ergonomics under load (forEach over an agent step, per-step
  budgets) — additive members, added when a real automation needs them.

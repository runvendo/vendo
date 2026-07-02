# Flowlet Automations: ENG-188 Phase 1 Proposals

**Date:** 2026-07-01
**Status:** Proposal, awaiting brainstorm with Yousef. Nothing here is implemented.
**Scope:** Concrete proposals for the parts of the automations engine that Decision 5 of the [platform architecture](2026-07-01-flowlet-platform-architecture-design.md) deliberately left open: DSL shape and expression language, storage, the embedded-mode firing path, and the authoring flow. Ends with an enumerated open-questions list with a recommendation per question.

## Already locked (not relitigated here)

From the architecture doc and ENG-188:

- Two execution tiers, one authoring surface; hybrid allowed (deterministic backbone with agent-step nodes).
- Compiler agent in chat emits an inspectable spec, rendered as a card the user can read, edit, pause.
- Deterministic tier is an **interpreted JSON step-graph DSL**, not generated code. Interpreter can only call registered tools; policy applies per step.
- Triggers: time (cloud scheduler), host webhooks (event types declared in the manifest), Composio triggers.
- Cloud execution in the `apps/cloud` worker under the brokered grant; jobs via pg-boss.
- Front half (DSL, interpreter, compiler agent) is pure library code, testable with an in-memory scheduler (track D). Back half lands on ENG-198.

---

## (a) The DSL

### Design goals

1. **Inspectable by a person.** A user reads the card and knows exactly what will happen. Every step is a registered tool call or a clearly-labeled agent step.
2. **One expression language everywhere.** Conditions, data mapping, and string interpolation all use the same language, so the compiler agent learns one thing and the card renders one thing.
3. **Closed world.** The interpreter can only call tools in the session's registered toolset (host API via the manifest, Composio, engine tools). No eval of arbitrary code, no network primitives, no filesystem.
4. **Policy per step.** Every step flows through the existing `ApprovalPolicy` / `wrapTool` path with the automation's principal, exactly like a chat tool call.

### Top-level spec shape

```jsonc
{
  "dslVersion": 1,                    // schema version of the DSL itself
  "name": "Late-night delivery snitch",
  "description": "Post to #general when I order delivery after midnight",
  "prompt": "hey, snitch on me in #general if I order delivery late at night again",
  "trigger": { /* see Triggers */ },
  "if": "<expression>",               // optional guard; false => run recorded as skipped
  "execution": {
    "mode": "steps",                  // "steps" (deterministic / hybrid) | "agent" (fully agentic)
    "steps": [ /* see Steps */ ]
  },
  "approvals": {
    "preAuthorized": ["maple_freeze_card"]   // dangerous tools the user pre-approved at creation
  },
  "limits": { "maxFiringsPerHour": 60 }      // loop/runaway protection, defaulted
}
```

- `prompt` keeps the original plain-English ask verbatim: it is the ground truth the user gave us, shown on the card, and re-fed to the compiler on edit.
- The tier is the `execution.mode` discriminator. Hybrid is not a third mode: it is `"steps"` with one or more `agent` steps inside.
- `approvals.preAuthorized` is written by the creation flow, never by the compiler directly (see section d).

### Triggers

```jsonc
// Time. Cron only in v1; timezone captured from the browser at creation.
{ "type": "schedule", "cron": "0 17 * * 0", "timezone": "America/Los_Angeles" }

// One-shot.
{ "type": "schedule", "at": "2026-07-15T09:00:00-07:00" }

// Host event. Event types are declared in the manifest (tools.json, Decision 3);
// the compiler can only reference declared events, same closed-world rule as tools.
{ "type": "host_event", "event": "transaction.created" }

// Composio trigger, with its native config passthrough.
{ "type": "composio", "trigger": "GMAIL_NEW_GMAIL_MESSAGE", "config": { "labelIds": "INBOX" } }
```

The trigger payload becomes `trigger` in the expression scope. For host events the payload schema comes from the manifest declaration; for Composio triggers from Composio's trigger schema; for schedules `trigger` is `{ firedAt }`.

### Expression language: JSONata

**Proposal: JSONata** for everything: guards, per-step conditions, and data mapping.

Why JSONata over the alternatives considered:

| Option | Verdict |
|---|---|
| **JSONata** | Query + transform + predicates in one language. Mature JS implementation, no eval, non-Turing-complete (bounded recursion), used by Node-RED/IBM App Connect for exactly this job. Reads well on a card (`trigger.amount > 500`). |
| CEL | Great predicates, but transforms/construction are weak and the JS implementations are immature. We would still need a second mechanism for data mapping. |
| JMESPath | Query only; constructing new objects and arithmetic are painful. |
| Custom mini-language | We own the parser, the docs, and the bugs, for no expressive win. |

**Two usage forms, one language:**

1. **Interpolation** inside any string value: `"text": "Order from {{ trigger.merchant }}"`. Each `{{ }}` is a JSONata expression evaluated against the scope, result stringified.
2. **Whole-value expressions:** when a value is exactly one `{{ expr }}` and nothing else, it resolves to the raw JSON value (array, number, object), not a string. This is the Zapier/n8n convention; it avoids a second syntax for typed mapping.

Guards (`if` fields) are bare JSONata predicates without braces, since they are always expressions.

**Expression scope** (the closed world an expression can see):

| Name | Contents |
|---|---|
| `trigger` | the trigger payload |
| `steps` | `steps.<id>.output` for every completed step this run |
| `run` | `{ id, automationId, firedAt }` |
| `user` | vouched subject claims (id, name, email if vouched) |

No access to secrets, other users, other runs, or anything not listed.

### Steps

Steps are an ordered list executed top to bottom. Control flow is **structured nesting** (branch and loop nodes contain child step lists), not an explicit edge graph. A nested tree is what a card can render legibly and covers the realistic automation shapes; an edge graph is a v2 escape hatch if we ever hit a real diamond-shaped need (open question 2).

Four node types in v1:

```jsonc
// 1. tool: call one registered tool. The workhorse.
{
  "id": "notify",
  "type": "tool",
  "tool": "SLACK_SEND_MESSAGE",
  "input": { "channel": "#general", "text": "..." },   // values support expressions
  "if": "<optional guard, skip step when false>",
  "onError": { "strategy": "retry", "attempts": 3 }     // "fail" (default) | "continue" | "retry"
}

// 2. agent: a bounded agent run inside the deterministic backbone (the hybrid node).
{
  "id": "digest",
  "type": "agent",
  "goal": "Write a friendly weekly spending digest from these transactions.",
  "input": { "transactions": "{{ steps.fetch.output.data }}" },  // context handed to the agent
  "tools": [],                                   // allowlist; [] = pure text/judgment, no tool calls
  "output": { /* JSON Schema; agent must return this shape, becomes steps.digest.output */ },
  "maxToolCalls": 10
}

// 3. branch: if/else over child step lists.
{
  "id": "size-check",
  "type": "branch",
  "if": "trigger.amountDollars > 500",
  "then": [ /* steps */ ],
  "else": [ /* steps, optional */ ]
}

// 4. for_each: bounded iteration.
{
  "id": "remind-each",
  "type": "for_each",
  "items": "{{ steps.fetch.output.overdue }}",
  "as": "item",                                  // adds `item` (and `index`) to child scope
  "maxItems": 100,                               // hard cap, defaulted
  "steps": [ /* steps */ ]
}
```

Notes:

- The fully agentic tier (`execution.mode: "agent"`) is exactly one `agent` node's fields at the top level (`goal`, `tools` allowlist, `maxToolCalls`), no step list. One mental model for both tiers.
- The `tools` allowlist on agent steps is enforced by the runtime (it builds the toolset for that run from the allowlist), not by prompt. Policy still evaluates every call inside the agent step.
- `id` is required, unique, `kebab-case`; it is the handle for `steps.<id>.output` and for per-step run results.
- Interpreter hard limits (defaulted, compiler cannot raise past a ceiling): max 25 steps per spec, max 100 `for_each` iterations, max run wall-clock (e.g. 5 min deterministic, 15 min with agent steps).

### Worked examples

All four are in the Maple demo-bank domain (host tools prefixed `maple_`, from the manifest; Composio tools by their slug).

#### 1. Deterministic, host event: the Slack snitch (demo parity)

> "snitch on me in #general if I order food delivery late at night"

```json
{
  "dslVersion": 1,
  "name": "Late-night delivery snitch",
  "description": "Post to #general when a late-night food delivery charge posts",
  "prompt": "snitch on me in #general if I order food delivery late at night",
  "trigger": { "type": "host_event", "event": "transaction.created" },
  "if": "trigger.direction = 'debit' and trigger.hour >= 0 and trigger.hour < 5 and (trigger.category = 'dining' or $contains($lowercase(trigger.merchant & ' ' & trigger.descriptor), 'delivery'))",
  "execution": {
    "mode": "steps",
    "steps": [
      {
        "id": "snitch",
        "type": "tool",
        "tool": "SLACK_SEND_MESSAGE",
        "input": {
          "channel": "#general",
          "text": "Late-night delivery alert: {{ user.name }} just ordered *{{ trigger.merchant }}* (${{ trigger.amountDollars }}). He set up this alert to snitch on himself. Someone stage an intervention."
        }
      }
    ]
  }
}
```

This replaces the entire hard-wired `rules-store.ts` + `buildSnitch` path with data. No LLM per firing.

#### 2. Hybrid, schedule: weekly spending digest

> "email me a spending recap every Sunday evening"

```json
{
  "dslVersion": 1,
  "name": "Weekly spending digest",
  "description": "Every Sunday 5pm, summarize the week's spending and email it to me",
  "prompt": "email me a spending recap every Sunday evening",
  "trigger": { "type": "schedule", "cron": "0 17 * * 0", "timezone": "America/Los_Angeles" },
  "execution": {
    "mode": "steps",
    "steps": [
      {
        "id": "fetch",
        "type": "tool",
        "tool": "maple_list_transactions",
        "input": { "since": "{{ $fromMillis($toMillis(run.firedAt) - 7*24*60*60*1000) }}", "limit": 200 }
      },
      {
        "id": "digest",
        "type": "agent",
        "goal": "Write a friendly, concise weekly spending digest: total spent, top 3 categories, anything unusual versus a typical week. Plain text, no markdown tables.",
        "input": { "transactions": "{{ steps.fetch.output.data }}" },
        "tools": [],
        "output": {
          "type": "object",
          "properties": { "subject": { "type": "string" }, "body": { "type": "string" } },
          "required": ["subject", "body"]
        }
      },
      {
        "id": "send",
        "type": "tool",
        "tool": "GMAIL_SEND_EMAIL",
        "input": {
          "to": "{{ user.email }}",
          "subject": "{{ steps.digest.output.subject }}",
          "body": "{{ steps.digest.output.body }}"
        },
        "onError": { "strategy": "retry", "attempts": 3 }
      }
    ]
  }
}
```

Deterministic backbone (fetch, send are fixed and cheap), one LLM call where judgment lives. The `output` schema makes the agent step composable: downstream steps reference typed fields, not prose.

#### 3. Deterministic with a danger-gated step: big-charge freeze

> "if any charge over $500 hits my card, freeze it and let me know"

```json
{
  "dslVersion": 1,
  "name": "Big charge card freeze",
  "description": "On any debit over $500: freeze the card, then notify me on Slack",
  "prompt": "if any charge over $500 hits my card, freeze it and let me know",
  "trigger": { "type": "host_event", "event": "transaction.created" },
  "if": "trigger.direction = 'debit' and trigger.amountDollars > 500",
  "approvals": { "preAuthorized": ["maple_freeze_card"] },
  "execution": {
    "mode": "steps",
    "steps": [
      {
        "id": "freeze",
        "type": "tool",
        "tool": "maple_freeze_card",
        "input": { "cardId": "{{ trigger.cardId }}", "reason": "Automated freeze: charge over $500" }
      },
      {
        "id": "notify",
        "type": "tool",
        "tool": "SLACK_SEND_MESSAGE",
        "input": {
          "channel": "#alerts",
          "text": "Froze your card: {{ trigger.merchant }} charged ${{ trigger.amountDollars }}. Unfreeze from the Maple dashboard if this was you."
        },
        "onError": { "strategy": "continue" }
      }
    ]
  }
}
```

`maple_freeze_card` is annotated dangerous in the manifest. Because the user pre-authorized it at creation (`approvals.preAuthorized`), the run proceeds unattended. Had they declined pre-authorization, the run would pause in `waiting_approval` at that step and notify them (see section b run states and open question 7).

#### 4. Fully agentic, Composio trigger: rent invoice handler

> "when my landlord emails me the monthly invoice, schedule the rent payment and reply to confirm"

```json
{
  "dslVersion": 1,
  "name": "Rent invoice autopay",
  "description": "When landlord emails an invoice: schedule the payment from checking, reply to confirm",
  "prompt": "when my landlord emails me the monthly invoice, schedule the rent payment and reply to confirm",
  "trigger": { "type": "composio", "trigger": "GMAIL_NEW_GMAIL_MESSAGE", "config": { "labelIds": "INBOX" } },
  "if": "$contains($lowercase(trigger.sender), 'landlord@example.com')",
  "approvals": { "preAuthorized": [] },
  "execution": {
    "mode": "agent",
    "goal": "The trigger payload is a new email from my landlord. If it contains a rent invoice, extract the amount and due date, schedule a payment from my checking account for one day before the due date, and reply to the email confirming the scheduled date and amount. If it is not an invoice, do nothing.",
    "tools": ["maple_list_accounts", "maple_schedule_payment", "GMAIL_REPLY_TO_EMAIL"],
    "maxToolCalls": 15
  }
}
```

Why agentic: the amount and date are inside unstructured email text, and "is this actually an invoice" is judgment. `maple_schedule_payment` is dangerous and NOT pre-authorized here, so every firing pauses for async approval before money moves; the user approves from the notification/card. That is the intended UX for money movement.

---

## (b) Storage shape

All behind the Store seam (`AutomationStore` interface): cloud = Postgres in `apps/cloud`, embedded = in-memory (SQLite later if a host wants durability). Shapes below are the Postgres reference.

### `automations` (mutable pointer row)

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id`, `user_id` | fk | owner; automations are per-user in v1 |
| `name` | text | denormalized from current spec for cheap listing |
| `status` | enum | `enabled` \| `paused` \| `disabled_error` (killed by repeated failures) |
| `current_version` | int | fk into `automation_versions` |
| `trigger_kind` | enum | `schedule` \| `host_event` \| `composio`, denormalized for the ingest fan-out query |
| `trigger_key` | text | e.g. event name `transaction.created` or Composio trigger slug; indexed with `trigger_kind` |
| `created_from_thread_id` | uuid nullable | provenance: the chat that authored it |
| `created_at`, `updated_at` | timestamptz | |

Index: `(tenant_id, user_id)`, `(tenant_id, trigger_kind, trigger_key) where status = 'enabled'` (the hot path: an event arrives, find who cares).

### `automation_versions` (immutable, mirrors the manifests pattern)

| column | type | notes |
|---|---|---|
| `automation_id`, `version` | pk | version increments on every edit |
| `spec` | jsonb | the full DSL document |
| `dsl_version` | int | copied out for migration queries |
| `pre_authorized` | text[] | tool names the user approved at this version's creation |
| `created_by` | enum | `user_edit` \| `compiler` |
| `created_at` | timestamptz | |

Every edit is a new immutable version; `automations.current_version` moves. Pre-authorization is stored on the version, because an edit can change which tools the spec uses and must re-prompt (open question 7). Runs reference the exact version they executed, so run history is always interpretable even after edits.

### `automation_runs`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `automation_id`, `version` | fk | exact spec that ran |
| `tenant_id`, `user_id` | fk | denormalized for retention/quota queries |
| `status` | enum | `running` \| `succeeded` \| `failed` \| `skipped` (guard false) \| `waiting_approval` \| `cancelled` |
| `trigger_payload` | jsonb | what fired it (truncated at a size cap) |
| `steps` | jsonb | array of `{ id, status, startedAt, finishedAt, output?, error?, toolCalls? }`; agent steps record their tool-call trace here |
| `error` | text nullable | terminal error summary |
| `started_at`, `finished_at` | timestamptz | |

Step results live **inline as jsonb** in v1, not a separate `run_steps` table: a run is one write-mostly document, specs are capped at 25 steps, and the card reads a run whole. Split it out only if per-step querying becomes real (open question 6).

`waiting_approval` runs hold a pointer to the pending approval (which reuses the existing approval-card machinery); pg-boss gives the resume-on-approve job.

Every tool execution inside a run also writes `audit_events` (Decision 6) exactly as chat tool calls do, tagged with `run_id`. Runs are the user-facing history; audit is the compliance trail. No duplication of concern.

### Retention

Proposal: keep full run rows **90 days**, additionally capped at the **most recent 1,000 runs per automation**; nightly pg-boss job prunes. Keep forever: per-automation counters (`total_runs`, `total_failures`, `last_run_at`, `last_status`) maintained on the `automations` row for the card's at-a-glance line. Embedded mode: ring buffer of the last 100 runs in memory.

---

## (c) Embedded-mode firing path (and how it maps to the cloud worker)

The invariant that keeps the cloud path safe: **everything from "a firing exists" onward is identical in both deployments.** Only the producers of firings differ.

```
producers (deployment-specific)                 core (identical everywhere)
--------------------------------                ---------------------------------------
embedded: in-process cron ticker   ─┐
embedded: host calls emitHostEvent ─┤
embedded: demo-bank poller adapter ─┼──▶  fire(automationId, triggerPayload)
cloud:    pg-boss cron jobs        ─┤       ├─ load current version (Store)
cloud:    signed webhook ingest    ─┤       ├─ create run row (Store)
cloud:    Composio trigger webhook ─┘       ├─ acquire credentials (CredentialBroker)
                                            ├─ evaluate guard → maybe `skipped`
                                            ├─ interpret steps / run agent goal
                                            │    └─ every tool call → policy → Executor
                                            └─ finalize run row + counters
```

- The runner takes `{ automation, version, triggerPayload, principal }` and uses only the seams: Store for run rows, CredentialBroker for identity (host session in-process when embedded; brokered grant token in cloud), Executor for tool calls, the existing policy layer per step.
- **Embedded Scheduler** (`InProcessScheduler`, the "none or host cron" seam slot): a single `setInterval` tick (once per minute) computes due cron triggers with a cron library (e.g. `croner`), plus an `emitHostEvent(type, payload)` method the host calls from its own code paths.
- **Demo-bank wiring:** the existing 2-second poller survives as an *adapter*: it keeps polling Maple's transactions API (true to "we didn't touch the bank"), diffs for new rows exactly as today, and calls `emitHostEvent("transaction.created", tx)` instead of matching hard-wired rules. `rules-store.ts`, `buildSnitch`, and the rule-matching logic are deleted; example 1 above is their replacement as data. A host with a real backend would call `emitHostEvent` from its own event path, or later, POST a signed webhook to the cloud, which is just another producer.
- **Cloud later (ENG-198):** pg-boss cron job per scheduled automation fires `fire()`; a webhook ingest route verifies the manifest-declared signature and calls the same internal `emitHostEvent`; Composio trigger webhooks likewise. Nothing in the runner changes.
- **Composio triggers in embedded mode:** not supported (they require a webhook endpoint Composio can reach). Embedded/demo gets `schedule` + `host_event`; this is an accepted limitation, not a design hole (open question 9).
- Concurrency and the "user edits while a run is mid-flight" problem: a run pins its version at creation, so edits never mutate an in-flight run. Per-automation firings are serialized in v1 (a firing that arrives while one is running queues behind it).

Placement: the DSL schema (zod), interpreter, and compiler-agent prompt live as a new module in `packages/flowlet-agent` (`src/automations/`) and move wholesale into `@flowlet/runtime` at the carve-out. Pure library, in-memory scheduler in tests, per track D.

---

## (d) Authoring flow in chat, and the card (outline only)

### Authoring flow

The compiler agent is **the chat agent itself with automation tools**, not a separate subagent. It already has the full registered toolset in context, which is exactly the vocabulary the compiler needs for the closed-world rule.

Tools added to the engine source:

- `create_automation(spec)`: input schema IS the DSL zod schema, so the ai SDK validates shape at the call boundary and malformed specs bounce back to the model with errors.
- `update_automation(id, spec)`: new immutable version.
- `list_automations()`, `get_automation_runs(id)`, `pause_automation(id)`, `resume_automation(id)`, `delete_automation(id)`.
- `run_automation_now(id, samplePayload?)`: test firing, marked as such in run history, so the user can see it work before trusting a schedule.

Flow:

1. User describes the automation in plain English (or asks to change one).
2. System-prompt compiler guidance steers tier choice: **prefer deterministic**; use an `agent` step only where a step genuinely needs judgment over unstructured input; go fully `agentic` only when the steps themselves are unknowable in advance. Validate that every referenced tool/event exists in the registered set.
3. The agent calls `create_automation`. Policy classifies this call as `approve`, always: creating standing authority to act unattended is inherently danger-gated. The approval card IS the automation card in its proposal state.
4. The proposal card enumerates the tools the spec uses, flagging dangerous ones, and asks the user to (a) approve the automation and (b) optionally pre-authorize the dangerous tools for unattended firing. Declining (b) still creates the automation; those steps pause for async approval each firing.
5. On approve: version row written, scheduler registered, card flips to its live state.
6. Edits: user asks in chat (compiler re-reads `prompt` + current spec, emits new version, same approval gate when the tool set changed), or edits from the card surface (Yousef-gated UI, later).

### Automation card: content outline

UI/UX is Yousef-gated; this is a content inventory only, no layout or visual decisions.

- **Header:** name; tier badge (deterministic / hybrid / agentic); status (proposed / active / paused / erroring).
- **Restatement:** one-sentence compiler-generated plain-English restatement of what it will do (which the user sanity-checks against their intent), plus the original prompt.
- **Trigger line:** human-readable trigger ("Every Sunday 5:00 PM PT", "When a transaction posts, if amount > $500").
- **Steps list:** one human-readable line per step in order, with the tool named and dangerous steps flagged; agent steps show the goal and their tool allowlist; branches/loops indent.
- **Permissions block:** every tool the spec can touch, its danger level, pre-authorized or ask-each-time.
- **Run summary:** last run status/time, run count, recent failures; entry point to full run history.
- **Actions:** approve/decline (proposal state); pause/resume, run now (test), edit, delete (live state); view raw spec JSON (the inspectability escape hatch).

---

## (e) Open questions, with recommendations

1. **Expression language.** JSONata vs CEL vs custom. **Recommend JSONata** (one language for guards + mapping, mature JS impl, non-Turing-complete, card-legible). Biggest counterargument: syntax is less C-like than CEL for pure predicates.
2. **Control flow: nested blocks vs explicit edge graph.** **Recommend nested blocks** (branch/for_each contain child lists). Cards can render them, the compiler emits them reliably, and they cover realistic automations. Revisit edges only on a demonstrated diamond-shaped need.
3. **`for_each` in v1?** **Recommend yes, with a hard `maxItems` cap** (default 100). "For each overdue invoice, send a reminder" is too common to defer, and it is cheap in an interpreter.
4. **Spec versioning.** Immutable `automation_versions` table vs jsonb history array on the row. **Recommend the versions table**: mirrors the manifests pattern, runs pin exact versions, pre-authorization naturally attaches per version.
5. **Run retention.** **Recommend 90 days AND last-1,000-per-automation, whichever prunes first; aggregate counters kept forever.** Cheap, predictable, enough for "why did this fire last month."
6. **Step results storage.** Inline jsonb on the run row vs a `run_steps` table. **Recommend inline jsonb for v1** (runs are read whole, specs capped at 25 steps). Split later if per-step analytics become real.
7. **Dangerous steps at firing time.** Pre-authorize at creation vs always pause for approval. **Recommend both, user-chosen per tool at creation**: the approval card offers pre-authorization per dangerous tool; anything not pre-authorized pauses the run in `waiting_approval` and notifies. Edits that change the tool set re-prompt.
8. **Where the compiler lives.** Same chat agent with `create_automation` tools vs a dedicated subagent. **Recommend same chat agent for v1**: it already holds the registered toolset, and zod validation at the tool boundary gives the correction loop. A dedicated compiler pass can come later if spec quality demands it.
9. **Composio triggers in embedded mode.** **Recommend cloud-only** (they need a reachable webhook endpoint). Embedded/demo supports schedule + host events; document the limitation.
10. **Runaway protection.** Automations can trigger events that trigger automations (freeze card → transaction event → ...). **Recommend a per-automation firing cap** (default 60/hour, spec-overridable downward only) plus `disabled_error` status after N consecutive failures (recommend 5) with a notification. Full cycle-detection is overkill for v1.
11. **Timezones.** **Recommend storing an IANA timezone on every schedule trigger**, captured from the browser at creation, and rendering fire times in it on the card. Naked UTC crons are a foot-gun for "every Sunday evening."
12. **DSL evolution.** **Recommend `dslVersion` int on every spec; the interpreter supports the current and previous version; a lazy migration rewrites old specs to current on next edit.** No eager fleet migrations.
13. **Fired-while-running semantics.** Parallel runs vs serialize per automation. **Recommend serialize per automation in v1** (queue the firing): simpler mental model, avoids duplicate-send races in digest-type automations.

---

## Out of scope for the brainstorm (already decided or someone else's epic)

- Card visual design: Yousef-gated, separate pass.
- Webhook signature scheme, token-exchange endpoint, pg-boss deployment: ENG-198 / ENG-202 back half.
- Management UI beyond the card outline: later, over the same Store methods.

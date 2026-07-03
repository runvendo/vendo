# ENG-193 — Safeguards & permissions: design (v2, post-brainstorm)

> **Status: brainstormed with Yousef 2026-07-02; this v2 reflects that session + a verified deep-research pass. Awaiting his review of this doc before any build.**
> Additive to the frozen contracts and the locked platform architecture (2026-07-01).

## 1. The problem

Today every dangerous action shows an approval card, every time, forever. That is repetitive (10 reminder emails = 10 cards), has no memory a user can see or manage, and trains click-through — and habituated approval is worse than no approval. The PRD bar stands: *bank-grade — the agent can be authenticated to do something and still not allowed to.*

## 2. Design principles (agreed in the brainstorm)

1. **Attention is the safety budget.** Every ask spends it. Ask only where `risk × intent-uncertainty` clears a bar; make every ask worth reading. (Empirical: 13/16 users in an MCP-consent study clicked "Always Allow" just to dismiss prompts; fMRI shows warning response collapses by the second exposure.)
2. **Asks scale with user decisions, not agent actions.** One explicit, enforceable decision may cover N actions (a batch, a task, an automation's lifetime, an envelope).
3. **Deterministic enforcement; LLM judgment only tightens.** OpenAI *trains* toward confirmation (91–100% recall by tier) because a browser is all they have. We act through a typed API — every gate is enforceable in the policy layer. Judges and classifiers may escalate a call to a card or deny it; they can never loosen anything.
4. **Everything remembered is an explicit, visible, revocable grant.** Nothing is memoised as a side effect. Invisible suppression (today's `rememberDecisions`) is retired.
5. **The permission system protects itself.** Tools that change permissions (create/edit automations, create grants) are themselves critical-tier. (Both Anthropic and OpenAI ship this.)
6. **Legibility over interrogation.** Trust comes from seeing what happened — activity feed, audit, undo — not from being asked constantly. (Chrome's quiet-chip A/B: ~30% less prompt friction, <5% fewer grants; Android's Privacy Dashboard.)

## 3. Danger tiers (four)

Derived from the `{mutating, dangerous}` annotations already required on every manifest tool; MCP hints map for Composio/MCP tools.

| Tier | Derivation | Behavior |
|---|---|---|
| **read** | `mutating: false` | Auto, audited |
| **act** | `mutating: true, dangerous: false` | Approval card on first contact; grantable |
| **critical** | `dangerous: true` — money, irreversible deletes, and **permission-changing tools** | Always confirm, named-action button, `stepUp` seam; **never grantable, in every posture** |
| **forbidden** | tenant/host config (ENG-194 lever) | Tool not in the toolset at all |

Invariants (stolen from Claude Code, kept from `remember.ts`): deny beats any grant in every posture; no user configuration, grant, or conversational instruction can loosen the critical tier; unknown-annotation tools fail safe into **act** with an "unverified" flag (open question 5). Optional manifest annotation `stepUp: true` marks critical tools needing host re-auth (seam: `requestStepUp(principal, action)`; demo fallback = typed confirmation).

## 4. The approval card (one card, all act-tier actions)

Brainstorm ruling (Yousef): no separate consent surfaces per action class — **one approval card system**, kept simple. Comms (email/Slack) are ordinary act-tier tools: the card already renders the tool input as labelled fields (recipient, subject, body), so reviewing what goes out needs no special draft surface.

**Act tier** — quiet chrome, split approve (Direction B, shipped verbatim by Claude in Chrome):

```
┌ Needs your approval ────────────────┐
│ Send email                          │
│   To        billing@acme.co         │
│   Subject   Overdue invoice #1042   │
│                                     │
│ [Allow once ▾]           [Decline]  │
│    ├ Allow once                     │
│    ├ Allow for this task            │
│    └ Always allow sending email     │
│      (scoped chips when derivable)  │
└─────────────────────────────────────┘
```

**Batches** — parallel same-tool calls group into one card, one decision for N actions:

```
┌ Needs your approval ────────────────┐
│ Send 10 emails                      │
│  ▸ Jim — "running late"             │
│  ▸ Acme billing — "invoice…"        │
│  ▸ …8 more (tap to review)          │
│ [Approve all 10] [Review each] [Decline] │
└─────────────────────────────────────┘
```

Sequential loops are covered by "Allow for this task" on the first card.

**Critical tier** — same card component, escalated register: amber accent, consequence line restated ("This can't be undone." / the amount), primary button names the action ("Confirm transfer" — never generic "Approve"), **no remember menu**, `stepUp` inserts host re-auth between click and execution.

Note: outbound comms are the prompt-injection exfiltration channel (hostile content read by the agent → instructions to forward data out), which is why sends default to asking rather than silent — but silence is one "Always allow" tap away, user-granted, visible in the Center.

One Flowlet-native extension kept as a note, not a pillar: a generated UI gesture (the Gmail swipe beat) can satisfy an approval via the existing signed approval-token path — the card is the default consent surface, not the only possible one.

## 5. One grant primitive

Every remembered decision — including "allow once" — is a `PermissionGrant`:

```
PermissionGrant
  id / tenantId / subject           store-assigned; Principal-scoped
  tool                              canonical name
  descriptorHash                    reuses automations/grants.ts hashing; manifest
                                    republish that changes the tool ⇒ grant lapses,
                                    next call re-asks (fail-closed drift, ENG-188-proven)
  scope                             STRUCTURED and renderable:
                                      { kind: "tool" }
                                      { kind: "exact", inputHash, inputPreview }
                                      { kind: "constrained", constraints: [...] }
                                        e.g. { path: "amount", op: "lte", value: 500 }
                                             { path: "to", op: "matches", value: "*@vendo.run" }
                                      { kind: "envelope", path, limit, window }   (v2)
  duration                          "standing" | "session" | "task"
  source                            { kind: "chat" } | { kind: "automation", id, version }
                                    | { kind: "compiled-rule" }   (from NL customization, §7)
  grantedAt / revokedAt? / expiresAt?
```

- Structured scope (not just a hash) so the Permission Center can render it; a hash is computed *from* it for fast deterministic matching (`canonicalJson`/`fnv1a64`). Constraint predicates are structural checks — no LLM at enforcement.
- **"Allow once" = a session-scoped exact grant** — same UX cost as today's ask-once, now visible and killable. `rememberDecisions` retires; its fail-closed invariants (record only on executed human approval; deny always wins) carry into the new `grantPolicy` layer.
- **"Allow for this task" = a task-scoped tool grant** — covers sequential loops ("handle my inbox") with one upfront decision; dies when the run ends.
- **Automation grants stay version-bound where they are** (their death-on-edit lifecycle is a safety feature); the Permission Center federates both stores into one list. Physical merge only if duplication ever hurts.
- OAuth's own authors concluded static scopes fail for payments — per-transaction structure (amount, recipient) is required. That is the argument for constrained scopes and envelopes over any blanket "always allow transfers" (which the critical tier forbids anyway).

## 6. Volume guardrails and circuit breakers

Volume is its own risk axis: a "send freely" grant is fine at 10 and alarming at 500 — same permission, different blast radius. Silence is granted; *unbounded* silence never is.

- **Anomaly breaker:** a granted act-tier tool trips back to asking on unusual volume ("about to send 47 emails — that's unusual, look first"). Deterministic thresholds v1 (per-tool count per task/day), judge-informed later.
- **Auto-posture breaker** (§8): N judge escalations in a window → posture drops back to Standard, mirroring Claude Code's 3-consecutive/20-total fallback and automations' consecutive-failure self-disable.
- **Envelopes (v2):** quantity and money budgets as grant scopes ("≤ $500/day to approved vendors", "≤ 20 sends/day") — the Brex/banking primitive, unshipped for agents anywhere.

## 7. Agentic customization (NL in, deterministic out)

Users tune the whole system conversationally — *"never ask about Slack drafts, always ask before anything touching Acme, cap sends at 20/day"* — and the agent **compiles it to the artifacts above**: grants, ask/deny rules, envelopes. Same philosophy as automations (NL → inspectable DSL, never NL → vibes), and the exact pattern Decagon ships as Agent Operating Procedures (business users author in NL; critical operations stay under code-enforced validation regardless).

- Compiled rules appear in the Permission Center as first-class rows (`source: compiled-rule`), editable/revocable like any grant.
- Compilation is itself a permission-changing act → **critical tier**: the compiled rule is shown for explicit confirmation before it takes effect.
- Tighten anything; loosen only within tier bounds. No phrasing talks the agent out of the critical tier.
- The existing `naturalLanguagePolicy` judge remains as a *runtime* tightening layer; compiled rules are its fast, auditable, deterministic sibling.

## 8. Postures (the autonomy dial, done safely)

Three postures, settable per session or per task. Tiers and grants do not change between postures — only the default friction of the *act tier* does. Critical is identical everywhere.

| Posture | Act-tier behavior |
|---|---|
| **Careful** | every act-tier call asks, grants ignored (temporary paranoia switch) |
| **Standard** (default) | cards + grants as designed |
| **Auto** | act tier flows without taps, **watched**: the judge supervises every call against stated boundaries + conversation context and can escalate any call back to a card; volume breakers armed; activity feed is the review surface; breaker drops posture back to Standard |

Auto is "act without asking, watched" (Claude Code auto mode, Sierra's supervisor panel) — never Copilot's one-way `--yolo`, which is the documented anti-pattern (all-or-nothing grant offered as "(recommended)" exactly when autonomy rises). "Just handle my inbox — don't ask" ≈ temporary Auto scoped to one task, which is the same thing as a task grant plus the watcher.

## 9. The Permission Center

One overlay surface, reachable from a persistent quiet affordance (shield in page/thread chrome — placement is Yousef's call):

```
┌─ Permissions ────────────────────────────────────────────┐
│  Vendo acts with your account. You decide what it may    │
│  do without asking.                    Posture: Standard ▾│
│                                                          │
│  ALWAYS ALLOWED                                          │
│  ✓ Create invoice drafts               since Jul 2   [⋯] │
│  ✓ Send email — only to *@vendo.run    since Jul 2   [⋯] │
│  ✓ Rule: "never ask about Slack drafts"  Jul 2       [⋯] │
│      [⋯] → Revoke · View activity                        │
│                                                          │
│  THIS SESSION / TASK                                     │
│  ✓ Read run history (this exact request)            [×]  │
│                                                          │
│  LIMITS                                                  │
│  ▸ Sends: 20/day (12 used) · Vendors: $500/day      [⋯]  │
│                                                          │
│  AUTOMATIONS — pre-authorized                            │
│  ⚡ Morning chase · Send reminder email   v3         [→]  │
│                                                          │
│  ALWAYS ASKS  (can't be changed)                         │
│  🛡  Transfer money · Delete customer · Change permissions│
│                                                          │
│  WAITING ON YOU (1)                                      │
│  ⏳ "Chase overdue" wants to send 3 emails      [Review] │
│                                                          │
│  ACTIVITY — 34 actions this week                    [→]  │
└──────────────────────────────────────────────────────────┘
```

Sections: standing grants + compiled rules (revoke, activity), session/task grants, envelopes with usage, automation federation (manage in the automation; revoking here removes the grant from the live version), the deliberately-shown "always asks" list (seeing what *can't* be granted is what makes the rest trustable; ENG-194 tenant-forced entries surface here later), the async approval inbox (automation `waiting_approval` runs; later SMS/voice-routed consent), and the activity feed (the retrospective trust engine).

**ENG-194 relation:** the Center is the per-user self-serve view over grant + audit rows that all carry `tenantId`; the enterprise console is the tenant-admin view over the same data plus org policy composing as another deny-capable layer. Decagon/Sierra ship only the admin half — Flowlet needs both because end users are the ones customizing.

## 10. Persistence & enforcement

- **Store seam:** additive `grants: GrantStore` member on the frozen core `Store` (`create/list/revoke/findForTool`, Principal-scoped, store-assigned identity — house rules). Embedded hosts pick the backing; cloud is Postgres behind the same interface. Truth is server-side where policy enforces; the shell reads through a client seam (gallery pattern) — a tampered client can render wrong, never authorize wrong.
- **Policy composition:**

```
composePolicy(
  roleRule / thresholdRule               deny/escalate, never suppressed
  compiledRules (from §7)                deny/escalate, never suppressed
  naturalLanguagePolicy (judge)          deny/escalate; supervises Auto posture
  [ENG-194 tenant policy — future]       deny/escalate, never suppressed
  volumeGuardrails (§6)                  escalate on anomaly
  grantPolicy(grantStore,                downgrades approve→allow for act-tier
    annotationTierPolicy())              calls with a live matching grant
)
```

- **Audit:** additive `AuditEvent` kinds `grant_created` / `grant_revoked` (scope snapshot) alongside existing `approval`/`tool_execution`/`grant_exchange` — ENG-194 becomes a query, not new plumbing.
- **Wire:** the grant gesture needs one additive channel (approval-response metadata or a grants endpoint called before approving) — implementation-time choice; nothing depends on which. Signed sandbox gestures (§4) ride the existing approval-token path from the Gmail-beat work.

## 11. Prior art (deep-research pass, 2026-07-02; 25 claims verified 3-0 against live primary sources)

- **Claude Code**: six permission modes; **auto mode** = background classifier replaces prompts, conversational boundaries are block signals, deterministic 3-consecutive/20-total fallback to prompting. Deny/ask rules apply in *every* mode; protected paths can't be pre-approved even by explicit allow rules (safety check runs before allow evaluation).
- **Claude in Chrome**: allow-once / always-allow-on-site / decline (Direction B, shipped); Settings→Permissions center with history + revoke; plan-level approval in "Ask before acting"; danger tier (purchases, deletion, **modifying permission settings**…) prompts regardless of mode or grant.
- **OpenAI Operator/ChatGPT Agent**: trained confirmation (91% recall; 100% on financial/permission actions); **Watch Mode** (sensitive contexts require live supervision — pauses if you look away); **takeover mode** (credentials structurally never seen by the model); hard refusal ceiling above approval (bank transfers refused even with consent — but only ~89% reliably, being training not architecture; our API position makes the same ceiling deterministic).
- **Copilot CLI** (anti-pattern): autopilot offers "Enable all permissions (recommended)" / a limited mode that auto-denies everything / one-way `--yolo`. No middle tier — the middle is this design.
- **Decagon** (closest structural analog): AOPs — business users author agent policy in natural language, compiled against code-enforced guardrails; refunds/identity verification under strict validation regardless of NL rules. **Sierra**: supervisor-agent panel (input filter, per-action output audit, individually-controlled agency, per-task LLMs). Both admin-only — no end-user permission surface.
- **Adjacent systems** (extracted, not triple-verified): MCP consent-fatigue study (13/16 clicked Always Allow to dismiss; 3/16 read prompts); fMRI habituation by second exposure; Chrome geolocation prompts 85% ignored/dismissed → quiet-chip A/B (40M users, −30% friction, <5% grant loss); Android 12 Privacy Dashboard (post-hoc audit timeline); OAuth Rich Authorization Requests (static scopes can't carry amount/recipient); Brex spend envelopes (shared pool / per-user recurring); LangChain HITL decisions (approve/**edit**/reject/respond); Replit production-DB deletion during an explicit freeze (why enforcement lives in the execution layer, not the prompt).
- **Industry gap = our opportunity**: nobody ships act-then-undo as a primary mechanism (browser agents can't undo third-party side effects; hosts behind a typed API can expose drafts and inverse endpoints), and nobody ships envelopes for agents.

## 12. Open questions for Yousef's review

1. **Posture surface** — is the posture switcher a v1 feature (Center + per-task offer) or does v1 ship Standard-only with task grants, postures later? Recommend: **Standard-only v1**, posture dial v1.1 — grants already remove most friction.
2. **Auto posture's judge cost/latency** — every act-tier call in Auto passes the judge. Acceptable (calls are seconds-scale anyway) or needs a fast-path? Recommend: accept in v1 of Auto; it's the safety story.
3. **Silent-by-default comms** — may hosts mark specific act-tier tools auto-allowed from day one (no first ask ever), or is silence always a user-granted upgrade? Recommend: **always user-granted** — even one approval builds the right mental model, and sends are the exfiltration channel.
4. **Constraint chips v1** — ship `tool`+`exact`+1–2 heuristic constrained scopes (recipient/domain, amount ceiling) in v1? Recommend yes; it's the memorable half of the UX.
5. **Unknown-annotation Composio/MCP tools** — act-but-flagged (recommended) vs critical-until-verified.
6. **Remembered declines** — recommend no for v1; persistent blocks belong to compiled deny rules (§7), which cover the need explicitly.
7. **Volume thresholds** — fixed per-tool defaults vs host-declared in the manifest? Recommend host-declarable with sane defaults.
8. **Undo contract shape (v2)** — manifest carries an inverse binding per undoable tool vs host-level undo endpoint. Park until v2, but the manifest extension point exists.

## 13. Shipping shape (each lands as its own PR; card + Center pause for Yousef's UI review before build and before merge)

1. Tiers + `grantPolicy` + `GrantStore` seam + audit kinds (runtime, no UI) — retires `rememberDecisions`.
2. Card v2: split approve ("allow once ▾ / for this task / always allow (scoped)"), batch grouping, critical-tier styling, session/task grants.
3. Permission Center (grants, rules, limits, automation federation, waiting-on-you, activity).
4. Volume guardrails + NL rule compilation (§6, §7).
5. v2 track: envelopes, act-then-undo (host undo contract), Auto posture + judge supervision, "approved 3×" nudge, step-up seam + demo fallback.

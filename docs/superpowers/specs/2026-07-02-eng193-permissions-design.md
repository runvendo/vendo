# ENG-193 — Safeguards & permissions hardening: design proposals

> **Status: PHASE 1 — proposals for Yousef's brainstorm. Nothing here is decided; nothing gets built until he directs.**
> Companion to the locked platform architecture (2026-07-01). Everything proposed is additive to the frozen contracts.

## 1. The problem

Today every dangerous action shows an approval card, every time, forever. Three failures:

1. **Repetitive** — approving "read run history" for the fifth time teaches users to click without reading. Habituated approval is worse than no approval.
2. **No memory** — the one memoisation layer that exists (`rememberDecisions`) is in-memory, exact-args-only, and invisible. The user can't see it, scope it, or revoke it.
3. **No management surface** — there is nowhere to answer "what is this agent allowed to do on my behalf?" Automations have per-tool pre-auth grants (ENG-188), chat has nothing, and the two don't know about each other.

The PRD bar: *bank-grade — the agent can be authenticated to do something and still not allowed to.*

## 2. What already exists (the raw material)

| Piece | Where | What it gives us |
|---|---|---|
| Policy engine | `flowlet-runtime/src/policy/` | Composable `ApprovalPolicy` layers; most-restrictive-wins (`allow` < `approve` < `deny`); `onExecuted` post-execution hook |
| Tool annotations | `flowlet-core/src/manifest/tool.ts` | `{mutating, dangerous, idempotent?}` **required** on every manifest tool; MCP-hint mapping for Composio/MCP tools |
| Ask-once memo | `policy/remember.ts` | Exact-args suppression, fail-closed invariants (record only on human-approved execute; deny always wins) |
| Automation grants | `automations/grants.ts` + `store.ts` | Scope-hashed per-tool pre-authorization: `{tool, descriptorHash, scopeHash, grantedAt}`; hash drift ⇒ re-approve; grants version-bound, never carried across edits |
| Approval card | `flowlet-shell/.../ApprovalCard.tsx` | Inline in-thread consent card, friendly action labels, Approve/Decline |
| Audit log | `core/src/seams/store.ts` | Append-only `AuditEvent` union already covering tool executions, approvals, grant exchanges, firings |
| Async approvals | `automations/store.ts` | `PendingApproval` + `waiting_approval` runs — automations already pause mid-run for consent |

The opportunity: the ENG-188 grant is the right primitive, but it's trapped inside automations and stored as opaque hashes. Generalize it into one user-visible permission system that chat and automations both consume.

## 3. Goals / non-goals

**Goals**
- One danger-level taxonomy driving default behavior for every tool, from annotations already required at publish.
- "Remember this decision" from the approval card, producing a scoped, revocable, *visible* grant.
- A Permission Center where the user sees and manages everything standing: chat grants, automation pre-auth, pending approvals.
- Grants persist per user behind the Store seam; deny always beats a grant.

**Non-goals (this epic)**
- Tenant-admin governance, approval routing, org policy (ENG-194 — but the data model must feed it).
- Real step-up authentication implementations (we define the seam; hosts own the mechanism).
- Cross-user / shared grants.

## 4. (a) Danger-level taxonomy

Three tiers, derived from the annotations every tool already carries. No new required manifest fields.

| Tier | Derivation | Default behavior | Grantable? |
|---|---|---|---|
| **read** | `mutating: false` (MCP: `readOnlyHint`) | Auto-allow, audited | n/a (already free) |
| **act** | `mutating: true, dangerous: false` | Confirm first use → **rememberable** | Yes — tool-wide or constrained |
| **critical** | `dangerous: true` (MCP: `destructiveHint`) | **Always confirm**, optional step-up | No in v1 (see open question 2) |

Rules on top of the table:

- **Unknown stays gated.** Tools with no informative hints (some Composio/MCP tools) keep today's fail-safe `approve` and sit in the **act** tier — grantable, but the card and Permission Center mark them "safety unverified" so granting is an informed choice. (Alternative: treat unknown as critical — safest but makes half of Composio permanently nag; see open question 6.)
- **Financial/irreversible = critical.** The extractor and manifest authors already express this with `dangerous: true`. We add one *optional* manifest annotation, `stepUp: true`, for the subset of critical tools where confirming in-chat isn't enough (move money, delete account) and the host wants re-authentication.
- **Tier is advisory defaulting, not the whole policy.** Principal rules (`roleRule`, `thresholdRule`), the natural-language judge, and future tenant rules still compose on top; any of them can escalate or deny. A grant can never override a `deny` — that's the "authenticated but still not allowed" invariant, and it's already how `remember.ts` behaves.

## 5. (b) The generalized grant

One record type for every standing permission, whatever surface created it:

```
PermissionGrant
  id              store-assigned
  tenantId        Principal scoping (same as every store row)
  subject
  tool            canonical tool name
  descriptorHash  FNV-1a over the tool descriptor (reuses automations/grants.ts);
                  manifest republish that changes the tool ⇒ grant silently lapses
                  and the next call re-prompts (fail-closed drift, proven in ENG-188)
  scope           STRUCTURED, renderable — not just a hash:
                    { kind: "tool" }                              — any input
                    { kind: "exact", inputHash, inputPreview }    — this exact call
                    { kind: "constrained", constraints: [...] }   — field predicates,
                      e.g. { path: "amount", op: "lte", value: 500 }
                           { path: "recipient", op: "matches", value: "*@vendo.run" }
  duration        "standing" | "session"
  source          { kind: "chat" } | { kind: "automation", automationId, version }
  grantedAt / revokedAt? / expiresAt?
```

Design points:

- **Structured scope is the difference from ENG-188.** Automation grants hash the scope because the automation version *is* the renderable context. A chat grant has no such home, so the scope must be readable in the Permission Center ("Send email — only to `*@vendo.run`"). We still compute a hash *from* the structured scope for fast, deterministic matching — same `canonicalJson`/`fnv1a64` helpers.
- **Constraint evaluation is deterministic.** Predicates are structural checks against the tool input (`eq`, `lte`, `gte`, `matches` on a dot-path). No LLM at enforcement time — the judge stays its own layer.
- **Grants are explicit, never inferred.** Unlike `rememberDecisions`, nothing is remembered as a side effect of approving. A grant exists only because the user picked a "always allow …" affordance. This retires invisible memoisation: **"Allow once" becomes a session-scoped exact grant** (same UX as today's ask-once, but now visible and revocable in the Permission Center under "This session").
- **Enforcement layer.** A new `grantPolicy(grantStore)` wraps the annotation layer: if a live, unexpired, hash-valid grant matches the call *and* the inner decision isn't `deny` *and* the tier isn't critical → downgrade `approve` → `allow`. Deny-capable layers (roles, thresholds, NL judge, future tenant rules) compose *outside* it and are never suppressed. `rememberDecisions` is retired, its invariants inherited.
- **Automations unification (v1 = federate, later = merge).** Automation grants stay version-bound where they live — that coupling (grants die with the version) is a safety feature we shouldn't disturb. The Permission Center *reads* both stores and presents one list; chat grants live in the new `GrantStore`. A follow-up can migrate automation grants into the same table with `source.automation` if we want one physical store. Recommendation: federate now, merge only if a real need appears.

## 6. (c) The Permission Center

One surface answering "what may the agent do without asking me?" — reachable from a persistent, quiet affordance in the shell (shield icon in the thread header / page chrome), opening as a Flowlet overlay section, sibling to the saved-flowlet library.

```
┌─ Permissions ────────────────────────────────────────────┐
│  Vendo acts with your account. You decide what it may    │
│  do without asking.                                      │
│                                                          │
│  ALWAYS ALLOWED                                          │
│  ✓ Create invoice drafts               since Jul 2   [⋯] │
│  ✓ Send email — only to *@vendo.run    since Jul 2   [⋯] │
│  ✓ Update customer notes               since Jul 1   [⋯] │
│      [⋯] → Revoke · View activity                        │
│                                                          │
│  THIS SESSION                                            │
│  ✓ Read run history (this exact request)            [×]  │
│                                                          │
│  AUTOMATIONS — pre-authorized                            │
│  ⚡ Morning chase · Send reminder email   v3         [→]  │
│      runs without asking · manage in automation          │
│                                                          │
│  ALWAYS ASKS  (can't be remembered)                      │
│  🛡  Transfer money · Cancel invoice · Delete customer   │
│                                                          │
│  WAITING ON YOU (1)                                      │
│  ⏳ "Chase overdue" wants to send 3 reminder emails [Review] │
└──────────────────────────────────────────────────────────┘
```

- **Always allowed** — standing chat grants: friendly action label (existing `tool-labels` machinery), scope qualifier, grant date, revoke. Revoke is immediate: next matching call re-prompts.
- **This session** — the "allow once" exact grants; they expire with the session and can be killed early.
- **Automations** — read-only federation of `AutomationVersion.grants`, linking into the automation's own management card (source of truth for editing stays there; a revoke here pauses that step's unattended run, i.e. removes the grant from the live version).
- **Always asks** — the critical tier, shown deliberately: seeing what *can't* be granted is what makes the rest trustworthy. This row is also where enterprise policy (ENG-194) will surface tenant-forced entries later.
- **Waiting on you** — the async approval inbox: automation runs in `waiting_approval`, and (later) approvals routed from other channels (SMS/voice per PRD). Chat approvals stay in-thread; this section is for consent requested while the user was absent.
- **ENG-194 relation:** the Center is the *per-user, self-serve* view over grant + audit data we already write. The enterprise console is a *tenant-admin* view over the same rows (all grants carry `tenantId`) plus org policy that composes as another deny-capable layer. Nothing in the Center's data model is per-user-only.

## 7. (d) Approval-card UX — three directions

Common to all: cards stay **inline in the thread** (the conversation is the consent context; a modal would break the sandbox-render flow and over-dramatize act-tier calls). Danger tier changes the card's visual register:

- **act** — current quiet shield, neutral chrome.
- **act, safety-unverified** — same plus a subtle "unverified tool" tag.
- **critical** — amber accent, explicit consequence line ("This can't be undone." / amount restated), primary button names the action ("Confirm transfer", never generic "Approve"), and `stepUp` tools insert the host's re-auth between click and execution.

### Direction A — remember checkbox

```
┌ Needs your approval ────────────────┐
│ Create invoice draft                │
│   Customer   Acme Co                │
│   Amount     $1,200                 │
│                                     │
│ ☐ Always allow creating drafts      │
│                                     │
│ [Approve]            [Decline]      │
└─────────────────────────────────────┘
```

One glance, zero extra taps. But the checkbox sits there on *every* card inviting reflexive tool-wide grants (habituation transfers from the button to the checkbox), and a checkbox can't express scope — it's all-or-nothing per tool.

### Direction B — split approve with scoped menu  ← recommended

```
┌ Needs your approval ────────────────┐
│ Send email                          │
│   To        billing@acme.co         │
│   Subject   Overdue invoice #1042   │
│                                     │
│ [Allow once ▾]           [Decline]  │
│    ├ Allow once                     │
│    ├ Always allow sending email     │
│    └ Always allow — to acme.co only │
└─────────────────────────────────────┘
```

Default tap = "Allow once" (session-exact grant), identical cost to today. The broader grant is one deliberate extra gesture, and the menu is where **constraint chips** live — scope options derived from the actual input (recipient domain, amount ceiling, account), so "always allow" is specific by construction. Critical-tier cards render the same card with *no menu* — only the named confirm + decline.

### Direction C — earn the offer (trust escalation)

```
   (3rd approval of the same action, after approving:)
┌──────────────────────────────────────────────┐
│ ✓ Sent email                                 │
│ You've approved this 3 times.                │
│ [Always allow sending email]  [Keep asking]  │
└──────────────────────────────────────────────┘
```

Approve stays a single button; the remember offer appears only once a pattern exists, so no card ever tempts a premature broad grant. Downside: relief is delayed exactly where the pain is (the repetition), and the offer-moment heuristic is one more thing to tune.

**Recommendation: B as the core, with C's nudge layered on later.** B solves the repetition at first contact, keeps "allow once" as the frictionless default, and is the only direction with a natural home for constraint scopes. A's checkbox is the classic dark-pattern-adjacent shape we should avoid in a bank-grade product. C is a lovely v1.1 addition on top of B (the nudge just deep-links the same grant creation).

## 8. (e) Persistence behind the Store seam

- Add a `grants: GrantStore` member to the core `Store` seam — the same additive move the architecture reserved for memory. Surface: `create / list / revoke / findForTool`, all Principal-scoped, store-assigned ids and timestamps (house authorship rule).
- **Truth is server-side** (wherever the runtime enforces policy): embedded hosts choose the backing (in-memory/SQLite in demo), cloud is Postgres behind the same interface. The shell never holds grant truth — the Permission Center reads through a small client seam the SDK wires to the runtime (like the saved-flowlet gallery pattern), so a tampered client can at most *render* wrong, never *authorize* wrong.
- Session-duration grants live in the same store with `duration: "session"`, keyed to the thread/session id and garbage-collected on expiry — visible while alive.
- **Audit**: additive `AuditEvent` kinds `grant_created` / `grant_revoked` (with scope snapshot). Together with the existing `approval` and `tool_execution` events, ENG-194's console becomes a query, not new plumbing.
- **Carrying the grant choice on the wire**: the approval response today is boolean approve/decline (ai SDK native). The scoped-grant gesture needs one additive channel — either metadata on the approval response or a separate grants endpoint called before approving. Decide at implementation; the seam design doesn't depend on which.

## 9. Policy composition after this epic

```
composePolicy(
  roleRule / thresholdRule            — deny/escalate, never suppressed
  naturalLanguagePolicy (judge)       — deny/escalate, never suppressed
  [ENG-194 tenant policy — future]    — deny/escalate, never suppressed
  grantPolicy(grantStore,             — may downgrade approve→allow for
    annotationTierPolicy())             act-tier calls with a live grant
)
```

Invariants (all inherited from proven code): deny always wins; grants suppress only the annotation tier's `approve`; critical tier is never downgraded; descriptor drift lapses the grant; nothing is remembered without an explicit user gesture.

## 10. Open questions for the brainstorm

1. **Card direction** — A (checkbox), B (split scoped menu), or C (earned nudge)? **Recommend B**, C added later as a nudge on repeat approvals.
2. **Is the critical tier ever grantable?** E.g. "always allow transfers under $100 to this saved payee." **Recommend: not in v1.** Always-ask is the trust anchor the whole system leans on; constrained critical grants are a deliberate later step, likely gated on ENG-194 so tenants can forbid it.
3. **Constraint scopes in v1 or v2?** The menu shape supports launching with just `tool` + `exact` scopes. **Recommend: ship the constrained scope shape in the data model from day 1, expose 1–2 heuristic constraint chips (recipient/domain, amount ceiling) in v1** — it's the memorable half of the UX and the model cost is already paid.
4. **How are constraint chips derived?** Deterministic heuristics per input field (email → domain chip, number → ceiling chip) vs. asking the LLM to propose scopes. **Recommend heuristics** — enforcement and offer should both be deterministic; LLM-proposed scopes can come later as *suggestions* that compile to the same predicates.
5. **Where does the Permission Center live?** Overlay section from a persistent shield affordance (recommended), a FlowletPage tab, or inside the library gallery. **Recommend the overlay + shield**: permissions deserve a stable, always-reachable home that doesn't compete with the creation surfaces. (UI placement is Yousef's call outright.)
6. **Unknown-annotation Composio/MCP tools** — act-tier-but-flagged (recommended) or critical-until-verified? Fail-closed purism says critical; pragmatics say a permanently nagging Gmail integration erodes the very attention we're protecting.
7. **Step-up mechanism** — define a host seam (`requestStepUp(principal, action)` → host shows passkey/password/OTP) and ship a typed-confirmation fallback in the demo? **Recommend yes**: seam now, host-owned mechanism, never Flowlet-owned credentials.
8. **Remembered declines ("never allow")?** **Recommend no for v1** — a decline stays one-shot; persistent blocks belong to deny-layer rules and ENG-194. Keeps the card binary and the mental model simple.
9. **Grant expiry** — no default expiry (recommended, matches "standing" semantics; `expiresAt` exists in the model for enterprise policy later) vs. e.g. 90-day auto-expiry for hygiene.
10. **Automation grants: federate or physically merge?** **Recommend federate in v1** (Center reads both; automation grants keep their version-bound lifecycle). Merge later only if duplication actually hurts.

## 11. Rough shipping shape (post-brainstorm, for scale only)

1. Taxonomy + `grantPolicy` + `GrantStore` seam (runtime, no UI) — retires `rememberDecisions`.
2. Approval card v2 (chosen direction, danger tiers, session grants).
3. Permission Center surface (grants list, revoke, automation federation, waiting-on-you).
4. Step-up seam + demo fallback; constraint chips if not in (2).

Each lands as its own PR with browser screenshots; card and Center pause for Yousef's UI review before build *and* before merge, per standing rules.

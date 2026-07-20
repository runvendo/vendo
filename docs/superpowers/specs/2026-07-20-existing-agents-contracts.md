# Existing-agents contracts — Wave 0 freeze

**Date:** 2026-07-20
**Status:** Frozen (Wave 0 of `docs/superpowers/plans/2026-07-20-existing-agents.md`)
**Spec:** `docs/superpowers/specs/2026-07-20-existing-agents-design.md`

Waves 1+ build against these shapes without moving them. Anything additive
stays within the `@1` versions; anything breaking bumps the version. The
frozen code lives in three type/schema modules, each with tests:

- `packages/core/src/tool-envelopes.ts` — envelope types + zod schemas
- `packages/agent/src/tool-pack.ts` — tool-pack names, options, delegate result
- `packages/ui/src/embeds.ts` — embed prop contracts (types only, no components)

## 1. Tool-output envelopes (`@vendoai/core`)

Same pattern as the MCP door's `vendo/open-in-product@1` card: a small JSON
object discriminated by `kind: "vendo/<name>@1"`. A `vendo_*` tool returns
either one envelope or plain data (plain data = the action executed cleanly;
the agent consumes it like any tool output, no embed).

```ts
export const VENDO_APP_REF_KIND = "vendo/app-ref@1";
export const VENDO_APPROVAL_REF_KIND = "vendo/approval-ref@1";

interface VendoAppRef      { kind: "vendo/app-ref@1";      appId: AppId;           title: string }
interface VendoApprovalRef { kind: "vendo/approval-ref@1"; approvalId: ApprovalId; summary: string }
type VendoToolEnvelope = VendoAppRef | VendoApprovalRef;
```

- Zod schemas (`vendoAppRefSchema`, `vendoApprovalRefSchema`,
  `vendoToolEnvelopeSchema`) are `.passthrough()`: readers tolerate unknown
  extra fields, so additive evolution stays within `@1`.
- `parseVendoToolEnvelope(output): VendoToolEnvelope | null` is the one
  dispatcher both sides share. `null` for plain data AND for a malformed
  envelope: the tool pack is the only writer, so a bad shape is a Lane A bug,
  not something a foreign chat surface should half-render.
- `title` is the app's display title known at `vendo_create_app` return time
  (the embed's chrome while the build streams). `summary` is one human-readable
  line describing what is waiting (Lane A derives it from the tool descriptor +
  input preview, same vocabulary as `ApprovalRequest.inputPreview`).

## 2. Public tool-pack API (`@vendoai/agent` types, umbrella subpaths)

Frozen names and option shapes in `packages/agent/src/tool-pack.ts`:

```ts
export const VENDO_TOOL_PACK_PREFIX = "vendo_";
export const VENDO_CREATE_APP_TOOL  = "vendo_create_app";
export const VENDO_DELEGATE_TOOL    = "vendo_delegate";

interface VendoToolPackFilter  { include?: string[]; exclude?: string[] }
interface VendoToolPackOptions extends VendoToolPackFilter {
  principal: Principal;
  sessionId?: string;   // host session id for audit continuity; unset → shim mints one per pack build
}

interface VendoDelegateResult {
  status: "ok" | "error" | "stopped";   // AgentRunReport["status"]
  summary: string;
  refs: VendoToolEnvelope[];            // anything the delegated run produced
}
```

Semantics frozen with them:

- **Namespacing.** Every pack tool ships under `vendo_`: a registered host
  tool `host_x` becomes `vendo_host_x`; the two built-ins are already
  prefixed. No tool reachable from a BYO loop has an unguarded route — the
  pack is a promotion of `buildAgentTools` (`packages/agent/src/tools.ts`),
  wrapping the same guard-bound registry Vendo's own loop uses.
- **Filtering.** `include`/`exclude` match FINAL (namespaced) names, exact
  string match. `include` unset = whole pack; `exclude` wins over `include`.
- **Context.** The pack executes with `venue: "chat"`, `presence: "present"`,
  no `appId` (the existing venue set is closed; a BYO loop is a chat surface
  that is not Vendo's). This tuple matters: the guard's one-shot approved
  replay pins venue/presence/appId, so park and resume must carry it verbatim
  (§4).
- **Umbrella subpath signatures** (Wave 1 Lane A implements; umbrella-typed,
  so they are recorded here rather than as code):
  - `@vendoai/vendo/ai-sdk`: `vendoTools(vendo: Vendo, options: VendoToolPackOptions): Promise<ToolSet>`
    — AI SDK `ToolSet` (the umbrella's existing `ai` peer, `>=6.0.0 <7`;
    the spec's "v5 ToolSet" reads as the current peer range), built per
    request because execution needs a principal-scoped `RunContext`.
  - `@vendoai/vendo/mastra`: `vendoMastraTools(vendo: Vendo, options?: VendoToolPackFilter): Record<string, MastraTool>`
    — Mastra `createTool` shapes for `Agent({ tools })`. Mastra agent
    definitions are static, so this shim takes NO principal; it resolves the
    principal (and optional session id) lazily per call from Mastra's runtime
    context. The runtime-context key names are Lane A's to pick and document;
    `@mastra/core` becomes an optional peer dep used only by this subpath.
- **Envelope outputs.** `vendo_create_app` returns a `VendoAppRef` fast (the
  build streams over the wire; the loop never blocks on generation). Any
  guarded call the policy sends to approval returns a `VendoApprovalRef`
  immediately — no throw, no block (§4). `vendo_delegate` returns
  `VendoDelegateResult` (plain data; the host may render each of its `refs`
  through `<VendoToolResult>`).

## 3. Embed prop contracts (`@vendoai/ui`, types only)

```ts
interface VendoAppEmbedProps      { refValue: VendoAppRef }
interface VendoApprovalEmbedProps { refValue: VendoApprovalRef }
interface VendoToolResultProps    { output: unknown }

type VendoApprovalEmbedState = "pending" | "executed" | "declined" | "expired";
```

- `<VendoToolResult output>` dispatches via `parseVendoToolEnvelope`: app ref
  → `<VendoAppEmbed>`, approval ref → `<VendoApprovalEmbed>`, plain data →
  renders nothing.
- All three live inside the existing `VendoProvider` pointed at the wire
  (auth rides the host session cookie, theme rides `--vendo-*` tokens); they
  take no client/config props of their own.
- `VendoApprovalEmbedState` is the frozen resolution vocabulary: the wire owns
  the state, the embed renders it in place (executed outcome, "declined",
  "expired") using the existing failed/expired vocabulary — no silent blanks.
- Lane B builds on existing machinery: slot rendering + build-beat for the app
  embed, `ApprovalCard` (`packages/ui/src/chrome/approval-card.tsx`) for the
  approval embed's consent surface.

## 4. Approve-resume today, and the exact Lane B gap

What the wire already supports (verified against code, and proven end-to-end
by `packages/vendo/src/approve-resume.e2e.test.ts`):

1. **Parking is guard-native.** `guard.bind(registry)` intercepts every
   execute; an ask-policy call parks via `#parkApproval`
   (`packages/guard/src/guard.ts`), which stores the EXACT call (guard-minted
   call id, tool, args) plus its `RunContext` in the `vendo_approvals`
   collection and returns `{ status: "pending-approval", approvalId }` —
   already non-throwing and non-blocking, exactly what the envelope needs.
2. **Deciding is wire-served and observable.** `POST /approvals/decide`
   (`packages/vendo/src/wire/approvals.ts`) calls `guard.approvals.decide`,
   which flips status once (atomic single-winner claim), audits, and fires
   every `guard.onApprovalDecision(id, approved)` subscriber (throws
   swallowed). `GET /approvals` lists pending requests for the principal.
3. **Approve mints a one-shot replay.** After approval, re-dispatching the
   byte-for-byte identical call through the guard-bound registry executes it
   exactly once: `#consumeApprovedCall` pins subject, call id, tool, exact
   args hash, descriptor hash, venue, presence, and appId. A fresh call id
   would re-park, not run.
4. **The only existing re-dispatcher is the apps runtime.** In-app actions
   (`apps.call`) park a `ParkedAction` record (`packages/apps/src/parked-action.ts`,
   collection `vendo_parked_action`, keyed by approvalId, `appId` REQUIRED)
   via `createAppCaller`'s `onParkedAction` hook; the runtime's
   `onApprovalDecision` subscriber (`packages/apps/src/runtime.ts`) re-executes
   the parked call on approve (try/finally always clears the record) and
   clears on deny (fail closed).
5. **Vendo-thread pending calls resume differently** — through the thread:
   `buildAgentTools` emits a `data-vendo-approval` stream part and the AI SDK
   needsApproval machinery resumes in-conversation. Abandonment (AGENT-6) is
   THREAD-driven: the next user turn sweeps the thread's stale asks into
   `guard.abandonApprovals` (deny path, idempotent). There is NO time-based
   approval TTL anywhere today; the ephemeral-session sweep only covers
   anonymous subjects.

The gap — what Lane B must add for a parked guarded call with NO Vendo thread
and NO app:

1. **A venue-neutral parked-call store + parking hook.** `ParkedAction`
   requires an `appId` and its lifecycle is app-owned (cleared on app delete),
   so BYO pack calls cannot ride it as-is. Lane B adds an umbrella-wired
   parked-call record (exact `ToolCall` + `RunContext`, keyed by approvalId —
   the same shape minus the app pin) written when a pack tool's guarded
   execute returns `pending-approval`, right before the tool returns the
   `vendo/approval-ref@1` envelope.
2. **An umbrella-level `onApprovalDecision` subscriber.** Same seam the apps
   runtime and automations already ride: on approve, re-dispatch the parked
   call byte-for-byte through the same guard-bound registry (the one-shot
   replay executes it); on deny, clear the record and never execute. Reuse
   the parked ctx verbatim — the replay pins venue/presence/appId (§4.3).
3. **Outcome persistence + a wire read for the embed.** Nothing today stores
   the executed outcome of a resumed call, and no route serves per-approval
   state: `GET /approvals` only lists pending, and `decide` returns nothing.
   `<VendoApprovalEmbed>` needs the wire to answer "what happened to
   `apr_x`?" with a `VendoApprovalEmbedState` (+ the executed result for the
   `executed` state), so Lane B persists the resume outcome keyed by
   approvalId and adds the read to the approvals wire area. (In-thread the
   outcome rides the thread stream; there is no thread here.)
4. **Expiry for orphaned parked calls.** The abandonment sweep is
   thread-driven and never fires for a BYO loop. Lane B adds a time-based
   sweep for parked BYO approvals that rides the EXISTING deny path
   (`guard.abandonApprovals` semantics: deny + clear, idempotent) — new
   trigger, not new semantics — and surfaces it as the embed's `expired`
   state. The spec's "existing approval TTL/abandonment sweep applies
   unchanged" refers to these semantics; the timer itself does not exist yet
   and is Lane B's to add.

Non-goals here (unchanged from the spec): no new venue value, no guard
protocol changes, no MCP-door changes.

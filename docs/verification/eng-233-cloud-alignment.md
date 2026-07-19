# ENG-233 — Cloud-alignment seam review (Block: @vendoai/ui)

Date: 2026-07-17
Reviewer pass before project close. Spec: `docs/superpowers/specs/2026-07-14-block-ui-design.md`.

**Decided meaning** (spec §"Cloud-aligned"): the ui surfaces expose the seams
Cloud features will plug into — sharing/publishing affordances and insights
instrumentation points — **without building those features**. This doc is the
seam inventory + a check that nothing shipped conflicts with the Cloud roadmap.

Verdict: **aligned**. Every Cloud feature has a UI-side seam already present and
additive; no shipped surface hard-codes an OSS-only assumption that Cloud would
have to tear out. Findings below are seam locations, not gaps to build.

## 1. Sharing / publishing seams

| Cloud feature (rides publishing, ☁️) | UI seam that's already here | Where |
| --- | --- | --- |
| Pin an app/component into the host product | `onPin(app)` provider callback; the in-thread app card renders a **Pin to dashboard** action only when a host supplies `onPin` (never a default). The slot pin path (ENG-223) mounts an approved `vendo-genui/v1` tree in place. | `context.tsx` `onPin`; `vendo-thread.tsx` `.fl-appcard-foot`/`.fl-appcard-pin`; `chrome/vendo-slot.tsx` `pin` prop |
| Approved-pin mount with host-page authority + drift | `PinMount` error boundary; `pinDrift` report is **server-authoritative** and stripped from in-thread previews; `client.apps.pinDrift` / `rebasePin` / `shipDiff` transports exist for the Cloud review console to drive. | `tree/frames.tsx` `PinMount`; `tree/renderer.tsx` (strips `inClient`/`pinDrift`); `client.ts` `shipDiff`/`pinDrift`/`rebasePin` |
| App portability (export/publish a saved app) | `useApps().exportApp` / `importApp`; `client.apps.exportApp`/`importApp` headless parity. | `hooks/use-apps.ts`; `client.ts` |
| In-client venue (approved code runs natively) | `payload.inClient` is server-authoritative; in-thread previews force it off (`inClient: _neverInThread`) so nothing unapproved ever mounts with authority — Cloud mints the approval, the ui already honors the flag. | `vendo-thread.tsx:825`; `tree/renderer.tsx` |
| Connect / OAuth (managed connectors) | The ENG-225 connect dock + tray ride an additive, opt-in `connectors` catalog on the provider; `client.connections.*` is the transport. OSS ships the surface; Cloud supplies the managed catalog. | `context.tsx` `connectors`; `chrome/connect-dock.tsx`; `chrome/connect-card.tsx` |

## 2. Insights / instrumentation points

| Cloud insights need | UI seam already present | Where |
| --- | --- | --- |
| What the agent did (the transparency ledger Cloud aggregates) | `useActivity` streams the self-scoped `AuditEvent[]`; the rebuilt Activity panel (ENG-224) renders it with real semantics + formatted times. Cloud reads the same audit stream org-wide. | `hooks/use-activity.ts`; `chrome/activity-panel.tsx` |
| Approval / consent outcomes (governance metrics) | `useApprovals` + the ApprovalCard decision path; the voice consent bar and `WaitingQueue` (ENG-225) decide through the same `client.approvals.decide`. Every decision is an audit event. | `hooks/use-approvals.ts`; `chrome/waiting-queue.tsx`; `voice/use-voice-approvals.ts` |
| Automation run history (usage/insight surface) | `AutomationsPanel` + run-history hooks over `client.automations`/`runs`. | `chrome/automations-panel.tsx` |
| Delivery / notification surface Cloud can target | `VendoToasts` + the imperative `vendoToast()` API (ENG-225) is a mount-once delivery point any Cloud push can drive. | `chrome/vendo-toasts.tsx` |
| Per-render telemetry hook points | Hooks all expose `{ data, error, isLoading, refresh }` + polling (ENG-219); a Cloud build can wrap the client without touching surfaces. | `hooks/*` |

## 3. Conflict check (nothing shipped blocks the roadmap)

- **No OSS-only hard-codes.** `onPin`, `connectors`, host tool metadata, and the
  voice `act` bridge are all **provider-optional** — absent → the surface
  degrades cleanly (no pin action, no dock, formatting fallback, no live tools).
  Cloud turns them on by supplying the prop; it never removes OSS behavior.
- **Server authority preserved.** `inClient` and `pinDrift` are honored, never
  originated, by the ui — the ui can't grant itself in-client authority, so the
  Cloud review console remains the sole minter of approvals. No shipped surface
  fabricates either field.
- **Contracts untouched.** Every additive seam this project shipped
  (connect-dock `connectors`, voice `act`/view/reconnect events) is behind the
  frozen 08-ui contract via the dated amendment log; the amendments are **parked
  for Yousef's sign-off** on `yousefh409/eng-229-voice-contract-amendments` and
  are NOT merged in the ui PR — so `docs/contracts/` stays byte-identical to main
  and Cloud inherits a clean contract surface.
- **Insights ride the existing audit stream**, not a new ui-invented event bus —
  Cloud aggregates the same `AuditEvent[]` the OSS Activity panel already reads.

## 4. Follow-ups for Cloud (out of scope here, documented for the roadmap)

- The **publishing/sharing chrome itself** (a "Publish" / "Share" affordance, org
  visibility toggles) is intentionally absent — it rides Cloud. When built, it
  plugs into `onPin` + `exportApp` + the app document, no ui-block rework needed.
- An **org-wide insights dashboard** aggregates `useActivity` across subjects;
  the per-user panel is the single-player half already shipped.

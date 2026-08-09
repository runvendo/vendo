---
"@vendoai/core": major
"@vendoai/apps": major
"@vendoai/store": major
"@vendoai/agents": major
"@vendoai/knowledge": minor
"@vendoai/actions": minor
"@vendoai/ui": minor
---

Dead features and their public surface are gone. Every removal below had zero
callers in this repo, the console, or the examples; nothing changed behavior for
a caller that was using a live path.

**`@vendoai/core` (breaking).** `AppDocument.placements` is gone from the
interface and the schema, and the validator no longer checks it. There has been
no writer since the placements-as-rows split; "show this app in that slot" is a
placement ROW (`@vendoai/apps` `placements.ts`, `GET /apps/placements`), which
is unchanged and is the live feature. Also removed: `PlanIsland` and the
`AppPlan.island` field, because the plan-level `<Island name purpose/>`
declaration no longer parses; and `PackSkill`, the deprecated alias for `Skill`.
`Pin`, `pinSchema` and `AppDocument.pins` are untouched — fork provenance is
still live.

**`@vendoai/apps` (breaking).** `PinShipRequest`, `PinApproval`,
`pinShipRequestSchema` and `pinApprovalSchema` never ran; `ShipDiffPin` and
`inClientApprovalSchema` are the live path and stay. `bindingKindCheck` is gone
— it had no callers; the `bindingKindIssues` walker it wrapped is still used by
the validate path. The plan compiler no longer accepts a plan-level
`<Island name purpose/>` element (an inline `<Island>` inside an app file is a
different, live feature and is unchanged). `GenerationPromptSection["id"]`
narrows to `"theme" | "design-rules"`; the other five ids had no producer.

**`@vendoai/store` (breaking).** The `stateStore` and `approvalStore` helpers
are gone. Both were test-only wrappers over the routed `records("vendo_state")`
and approval write paths, which are unchanged and are what production uses.
`ApprovalRow` is unaffected — it is exported from `helpers/types.ts` as before.

**`@vendoai/agents` (breaking).** The `./harnesses` subpath export is gone.
Import the harness factories from their own package instead:
`import { claudeCode } from "@vendoai/harnesses/claude-code"` and
`import { vendo } from "@vendoai/harnesses"`.

**`@vendoai/knowledge`.** `knowledgeIndexSummary` and `parseKnowledgeConfig` are
no longer exported from the package root. Both functions stay and are still used
internally by `knowledgeIndexResolver`, which remains exported.

**`@vendoai/actions`.** `DEFAULT_CAPTURE_BUDGET_BYTES` is no longer exported.
The constant and the 256 KB default it sets are unchanged.

**`@vendoai/ui`.** The unexported, unreferenced `TakeoverPortal` component is
deleted.

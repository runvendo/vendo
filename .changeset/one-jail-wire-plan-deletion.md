---
"@vendoai/apps": minor
"@vendoai/harnesses": minor
"@vendoai/vendo": minor
---

The wire format (`app.vendo`) and the plan dialect (`plan.vendo`) are gone. One
artifact writes a screen now — `app.tsx`, a React component through the sealed
screen engine — so there is one security model, one execution engine and one
renderer. The tree stays: it is still the JSON currency the renderer paints.

Removed from `@vendoai/apps/contract`: `compileWire`, `WireCompileOptions`,
`WireCompileResult`, `expandInlineRefs`, `InlineRefsResult`, `WIRE_ISSUE_CODES`,
`WIRE_ADVISORY_ISSUE_CODES`, `isAdvisoryWireIssue`, `WireIssue`, `WireIssueCode`,
`printWire`, `WirePrintInput`, `WirePrintOptions`, `compilePlan`,
`PlanCompileResult`, `PlanFacts`, `planTabs`, `PLAN_DISPLAYS`, `AppPlan`,
`PlanDisplay`, `PlanGroup`, `PlanLeaf`, `PlanQuery`, `PlanServer`, and the
island-derived-values surface. `checkBindingShapes` and `BindingShapeError` stay
— they moved to `genui/shape-check.ts` and still serve the screen's
bindings-fit check. `evaluateExpr` and the brace grammar stay: the renderer
evaluates them.

Renamed, because "wire" no longer names anything: `KIT_WIRE_UNSAFE_NAMES` is
`KIT_NON_SCREEN_NAMES` and `KIT_WIRE_COMPONENT_NAMES` is
`KIT_SCREEN_COMPONENT_NAMES`. The `WIRE_COMPONENT_NAMES` alias is deleted.

Removed from `@vendoai/apps`: `skeletonFromPlan`, `checkoutApp`,
`AppsRuntime.authored` (`authoredScreen` is the screen's counterpart and stays),
`AppsConfig.escalatedPlan`, `create({plan})`, `RenderSeamOptions.authoredApp`,
`RenderSeamOptions.facts`, `AppFloor.compile` and `AppFloor.check` — the floor
has one method, `component()`. `HOT_PATH_FILES` is `["app.tsx"]`, so the render
seam watches, checks and paints exactly one file. `validateWrittenApps` no longer
takes a `workspace` and no longer has a `{document}` door — a screen's mechanical
half already ran as its paint gate, so the gate's one call is `validate({appId})`
— and the `validate` verb itself takes `{ appId }` only.

Escalation stays and is re-shaped. The screen agent's `escalate` hand takes one
plain sentence — why assembly cannot serve this ask — and the builder is handed
the person's ORIGINAL prompt beside it. Nothing pre-plans the build and nothing
pre-declares the box's interface. The cost is the instant outline: an escalated
build now shows a plain building state until the box has something real to show.

Two consequences of the plan's removal, both visible to a host:

- A box that reported no interface is now a FAILED create/edit rather than a
  warning. It used to be reported only for a plan that required a served
  surface, because a layer-2 failure still left the plan's skeleton standing —
  and there is no skeleton now, so a silent success would be an empty app
  declared ready.
- The 2→3 served-surface flip has no trigger left. `<Server served>` was its
  only source, so an app can no longer BECOME a served app; everything about one
  that already is (`ui: "http"`) — the serve door, ping, fork refusal, box-path
  edits — is untouched.

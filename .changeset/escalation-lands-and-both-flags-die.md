---
"@vendoai/apps": major
"@vendoai/harnesses": minor
"@vendoai/vendo": major
---

**BREAKING:** escalation gets its receiving end, and both experimental flags are
deleted. `apps.experimentalScreenAgent` and `apps.experimentalMachines` are gone
from `createVendo()`; passing either is now a type error.

**The screen agent is THE engine.** Every `vendo_make` ask starts in the cheap
assembly loop on every deployment. There is no flag and no coin-flip. The
conductor is unchanged and is still what an `unavailable` answer, a broken
assembler, or an `assembled` that left no app row falls through to.

**Machine-backed execution is gated by the sandbox adapter, and nothing else.**
Configure `createVendo({ sandbox })` and layer-2 boxes are reachable; leave it
out and they are not. Presence IS the deliberate opt-in — no capability boolean
beside it. Every read site moved: the box lane in `laneGates`, the box seam
inside the generation pipeline, and `apps.machine.provision`, whose refusal now
names the missing sandbox instead of a flag. Layer 3 is unchanged: a narrowing
of layer 2 that additionally needs the mounted wire and `VENDO_BASE_URL`.

**`escalate` now lands somewhere.** It used to fall through to the conductor with
the plan discarded — which meant the person watched a skeleton, then watched an
unrelated app replace it. Two answers now, and the deployment's own shape picks
which:

- **A sandbox is configured** → the build runs. The same `create` a
  server-needing ask has always taken, at the SAME app id, so the plan's skeleton
  and the finished app share one stream and the outline becomes the app in place.
- **No sandbox** → a `failed` receipt whose `say` names the capability gap in the
  person's own terms. Not a fall-through: the conductor is assembly too, so it
  cannot serve what assembly just escalated, and trying would spend a whole
  build's latency to arrive at a worse version of the screen already on screen.
  The still-forming card is unmounted by the UI once the turn is over, so the
  receipt is the last word rather than a permanent shimmer.

**The build anchors on the escalated plan.** `AppsRuntime.create` takes an
additive `plan?: string` — the ask still travels verbatim and the plan rides
beside it as the brief, so the brain builds the outline the person is watching
rather than re-answering the ask from scratch. The plan is read back out of the
app's workspace through a new adapter slot, `AppsConfig.escalatedPlan`, filled by
composition for the same reason `AppsConfig.screen` is: `@vendoai/apps` holds no
workspace. Unfilled, the build plans from the ask exactly as before.

Additive surface: `AppsRuntime.machine.available()` (is a sandbox configured),
and `escalatedPlanPath(appId)` from `@vendoai/harnesses` so the writing and the
reading side cannot spell the plan's path two ways.

**Migration:** delete `apps: { experimentalScreenAgent: true }` — it is the
default now. Delete `apps: { experimentalMachines: true }` — if the deployment
already passes a `sandbox`, machines stay on with no further change; if it does
not, machines were never reachable anyway.

---
"@vendoai/harnesses": major
"@vendoai/vendo": major
"@vendoai/apps": minor
"@vendoai/core": minor
---

The checks floor moves to the paint seam, and `instant()` is removed.

## BREAKING: `instant()` is gone

`instant()`, `InstantHarnessDeps` and `InstantHarnessOptions` are removed from
`@vendoai/harnesses` and from the `@vendoai/vendo/server` re-export. Two engines
and no third: the lean `vendo()` loop, and the builder on the claude-code
runtime.

The specialist existed to put a layout on screen in seconds by routing an app ask
straight at the guarded engine tool. The paint seam now does exactly that for
**every** harness — a plan file renders its skeleton the moment it parses,
whoever wrote it — so its whole reason for being was absorbed by the thing every
thinker already rides.

**If you had `harness: instant()`:** delete it. The slot's default is `vendo()`,
which is the same guard, the same audit trail, the same view channel, and the
same skeleton-in-seconds behaviour.

```diff
- import { createVendo, instant } from "@vendoai/vendo/server";
+ import { createVendo } from "@vendoai/vendo/server";

  export const vendo = createVendo({
-   harness: instant(),
    auth: { ... },
  });
```

## The checks floor runs on every commit, for every author

The render seam compiled `app.vendo` with `compileWire(content)` and **no
options**, so it spoke a different dialect than every other compile of model
wire. Measured, both directions:

- a lying binding — a `$path` naming a field the tool's response shape does not
  have — compiled to `issues: []` and `bindingErrors: []`. "The engine's
  unshippable gate" was structurally dead on the files-first path, and the app
  painted a label promising a number it could never show.
- an app built on inline tool references had its binding **dropped** and its
  query never minted, and painted anyway, because the tree kept its children.

So nothing checked a harness's own writes. The floor was live for the built-in
conductor and structurally dead for every other author — a builder writing
`app.vendo` with its own hands, a human with an editor.

Now composition injects the floor into the seam (`RenderSeamOptions.floor`, built
from the new `AppsRuntime.floor(ctx)`). Every commit to `app.vendo` compiles in
the production dialect and runs the seven deterministic fact checks plus whatever
the host plugged in through a pack. A blocking finding means the view does not
paint — through the seam's existing "emits nothing, the last good view stays"
mechanism, not a new failure channel — and the write still lands, so `validate`
can read it back and repair it.

Hosts need no code change for this: the seam is wired in composition.

## `validate` runs the whole floor, and the builder must pass it

`AppsRuntime.validate` built its layer from `config.checks` alone, so it ran the
fact checks and skipped the AI reviewer. The building-apps skill teaches
"validate after every edit", and what it taught could not see invented data,
dishonest tool use, dead controls, dropped work, or a single one of the host's
own judgment **rules**. The reviewer is now composed in, fail-open as everywhere
else: silence, a refusal, and a failed request all mean no findings.

The claude-code harness's loop now requires it. After the turn's work reaches the
store, the loop calls the same registered `validate` verb through
`turn.tools.call` and, if an app document does not pass, hands the findings back
for **one** bounded fix round. New exports for hosts driving their own harness
loop: `validateWrittenApps`, `repairInstruction`, `VALIDATE_TOOL` from
`@vendoai/harnesses`.

## `Finding` carries its check

`Finding` gains an optional `check` naming the `Check` that produced it, stamped
by the checking layer. Additive — existing readers are unaffected — but code that
asserts exact `Finding` object equality will see the extra field. It makes
architecture design §7's carve-out ("except host-check failures, which only the
host can waive") representable for the first place: a built-in fact finding and a
host's own plugged check were previously the same anonymous object.

## Also

`@vendoai/core` gains the `AppFloor` port. The generation conductor is
**quarantined** (`@deprecated`): its callers are frozen, not extended, and new
work uses the lean loop with the floor at the seam.

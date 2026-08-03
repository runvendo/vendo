---
"@vendoai/harnesses": minor
"@vendoai/vendo": minor
"@vendoai/core": patch
---

`instant()`, the default-route flip, and the consolidated `createVendo` surface.

**`instant()` — the non-agentic specialist.** `@vendoai/harnesses` gains a
second built-in thinker for hosts that want speed as the resident. One routing
call sorts the ask into create / edit / act / cannot; an app ask goes STRAIGHT
to the guarded apps tool, so the plan — which is the layout — reaches the screen
while a resident thinker would still be forming its first sentence. Non-app asks
act through the same guard door, capped at two steps so it is never a thinking
loop. Genuinely impossible asks refuse in the consumer's voice. Every host
effect goes through `turn.tools.call()`, so the guard, the audit row, the
approval card, the view channel and the transcript mirror are unchanged — the
specialist buys speed, never a second safety story.

```ts
import { createVendo, instant } from "@vendoai/vendo/server";
const vendo = createVendo({ auth: authJs(), harness: instant() });
```

**`POST /threads` now runs through the harness runtime for every host** — the
host's harness when they named one, `vendo()` when they did not. The rails that
kept this opt-in (`find_tools`, the connection-scoped loadout, the curated menu,
capability-miss detection) all reach the harness path, and the assembled system
prompt rides the turn. Deployments whose store has no SQL handle (the Cloud
hosted store, or a host's own non-SQL adapter) stay on the shipped agent path,
because the transcript and workspace are tables.

**The config surface is consolidated onto §10's eight slots** — `auth`, `tools`,
`harness`, `packs`, `models`, `store`, `files`, `sandbox`. Additive only; no
shipped host breaks:

- NEW `tools:` — the host's own tool declarations in memory, the same
  `ExtractedTool[]` `vendo init` / `vendo sync` write to `.vendo/tools.json`.
  Precedence: `tools:` → `profile.tools` (now deprecated) → the file.
- `model` → `models.default`, `paint` → `models.fill`, `profile.tools` →
  `tools:`. All three still work for one more minor and warn once, naming the
  move.
- Every one of the 33 top-level keys has a stated destination, and the table is
  gated: a key added to the config without a documented destination fails a
  test.

Also: the docs-rot gate on `handler-options.mdx` is real again. Its
exhaustiveness assertion lived in a test file, which this package's tsconfig
excludes from typecheck — so it never compiled and the documented key list sat
ten keys behind the interface. The list moved into `src/config-keys.ts`, where
both directions of the assertion actually run.

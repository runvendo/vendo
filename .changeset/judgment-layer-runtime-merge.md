---
"@vendoai/actions": patch
"@vendoai/vendo": patch
---

Wire `.vendo/judgments.json` into the runtime read path: the AI layer now
actually applies, between the machine layer and the human one.

Host tools compose as `tools.json < judgments.json < overrides.json` — the
scanner's skeleton, hardened by its standing judgment, then corrected by the
authored override, which still wins last. `LoadedHost` carries the parsed
judgments file, and `loadHost` reads it in the same `Promise.all` as the pair.
Absent is fine; MALFORMED fails loudly at load, the same fail-closed posture as
`overrides.json` and for the same reason — the file can carry disables and
audience exclusions, so silently ignoring a broken one would silently loosen the
live surface.

Judgments are a HOST-tool layer only: connector, registry, and compound tools
are untouched. Lane A's safety properties hold on the read path — a `pending`
loosening never applies, and a judgment whose `binding` no longer matches the
tool's identity is wholly inert.

`mergedHostSemantics` gains the matching leg, so generation sees the same three
layers: `tools.json` semantics, then `judgments.json` `fields.semantics`, then
the authored overrides. `createVendo`'s host-semantics provider reads
`.vendo/judgments.json` alongside the pair, live per generation.

Also fixed: the zero-live-host-tools boot warning derived enablement by hand
from `overrides.json` alone, so a deployment whose host tools were all disabled
by judgments would have shipped a silently useless agent without warning. It now
reads the same effective state the registry dispatches from.

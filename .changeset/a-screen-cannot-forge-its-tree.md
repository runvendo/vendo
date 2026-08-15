---
"@vendoai/apps": patch
---

A screen cannot forge the tree it hands back.

The screen's own code evaluates inside the VM the engine already set up, so every name the engine still reached for AFTERWARDS was the screen's to redefine underneath it. A screen that assigned `JSON.stringify` handed the host a whole tree it never rendered, and the gauntlet passed it.

The engine now holds the intrinsics it uses after that point — `stringify`, `keys`, `isArray`, `create` — in closure variables taken before the screen's first line. `__vendo` is installed non-writable and frozen, and the module space moved onto it, so `__vendo_modules` and `__vendo_require` are no longer globals and `installSource` freezes the space before the screen runs.

The emitter reads OWN keys onto a null-prototype object and never emits `__proto__`, `prototype` or `constructor`; the host's `JSON.parse` reviver drops the same three as a second lock. And serialization measures what it is about to hand over — core's `TREE_MAX_NODES`, a depth cap and a size cap — inside the VM, because the host's gate on the other side of `JSON.parse` is one parse too late.

No API changes. One refusal message changed: the paint budget says it measures UTF-16 code units, which is what `json.length` reads — a CJK-heavy paint could reach ~3x the 512 KiB the sentence used to claim. The node and depth caps bound the tree independently, so the sentence was corrected rather than the check.

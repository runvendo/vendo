---
"@vendoai/apps": minor
---

Screen checking runs where there is no Node — Cloudflare Workers included.

Checking a component screen means compiling it, type-checking it and RUNNING it,
and all three used to happen the only way a Node process can: esbuild's native
binary, the `typescript` package resolved off disk, and a QuickJS build that
compiles its own WebAssembly at runtime. `createApps` gains a `toolchain` slot
that holds those three behind one adapter, so a deployment whose checks happen
where none of them is reachable fills the slot and every other stage runs
unchanged. Hosts on Node pass nothing and get exactly what they had.

`@vendoai/apps/edge` is that adapter for a Worker: sucrase instead of esbuild,
the real TypeScript compiler reading its standard library from string constants
instead of files, and the screen VM on a `WebAssembly.Module` your deployment
imported at build time — the one piece a Worker cannot produce for itself.

```ts
import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm";
import { edgeToolchain } from "@vendoai/apps/edge";

createApps({ ...config, toolchain: edgeToolchain({ wasmModule }) });
```

Its dependencies are OPTIONAL PEERS, the shape `@vendoai/apps/e2b` already uses:
a Node host installs none of them and pays for none of them.

A screen's execution budget can now be counted in INSTRUCTIONS rather than wall
time (`opsBudget()`). A Workers isolate freezes its clock while your code burns
CPU, so a time-based deadline gets asked "has the time run out?" a million times
and truthfully answers "not yet" every time — a runaway screen never stops.
Counting interrupts does not depend on a clock that moves. Node hosts keep the
wall-clock budget as the default.

**Three kinds of screen are now REFUSED that used to pass.** A screen that
declares a `namespace` block, one that writes a class `static { … }` initializer
block, and one that relies on sloppy-mode semantics — a write to a frozen object
being silently dropped, for instance — each come back as a named finding rather
than a checked screen. All three compile differently depending on what compiled
them, so a screen resting on one is a screen that works in the venue it was
checked in and breaks in the next. If your app generates its screens, the next
revision fixes them; if one was written by hand, the finding names the construct
and the line.

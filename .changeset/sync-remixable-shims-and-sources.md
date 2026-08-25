---
"@vendoai/actions": minor
"@vendoai/vendo": minor
---

`vendo sync` finds `<Remixable>` behind a re-export shim, outside the sync root,
and never misses one in silence.

Three things a real host repo needed and did not have:

**Shims are followed, not pattern-matched.** A wrapper's `Remixable` used to be
recognized by testing the import's module name against `@vendoai/ui`, so a host
that forbids deep `@vendoai/*` imports and re-exports through its own kit
module (`import { Remixable } from "@host/vendo-kit"`) captured nothing. Sync
now READS the shim's exports and follows them back to `@vendoai/ui` —
`export { Remixable } from`, `export * from`, `import` then `export`, aliases,
namespaces, relative or tsconfig-aliased, through as many host-local hops as it
takes. Proof, not a guess: a chain that never reaches `@vendoai/ui` is still
never captured, so a same-named component from somewhere else stays out.

**The silent miss is loud.** `pins: 0 captured, 0 drifted` printed over a file
with `<Remixable>` right there in it was the real bug. Every wrapper sync finds
and cannot attribute is now reported on the line under that count, naming the
file, the line, the specifier it did not recognize, and the two exact edits that
fix it. Carried on the report as `pins.unattributed` for `--json` and
programmatic callers. It is a warning, not an exit code — sync cannot prove
someone else's `Remixable` is Vendo's, so it says so instead of failing a build
on the guess. An unattributed wrapper also blocks baseline pruning: a host who
just moved imports behind a shim still has every wrapper they had yesterday, and
pruning on that reading would delete the baselines their forks live on.

**Sources outside the root.** New `remix.sources` in `.vendo/overrides.json` —
extra directories sync scans for wrappers, resolved from the project root and
free to sit outside it, for the repo whose app is `host/` and whose screens are
`../demos/`. Captured module ids stay relative to the project root (a file under
an extra source reads as `../demos/…`), so ids remain unique and existing
baselines do not move. A configured path that names nothing warns instead of
quietly contributing nothing. `remix.ignoreSlots` is now optional, so a project
can set `sources` alone.

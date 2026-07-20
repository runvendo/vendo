# W4b — islands: ambient scope + ambient tools (branch yousefh409/vendo-w4-islands)

RESUMABLE: commit each step. Authority: spec §format Islands
(git show origin/yousefh409/format-gen-v2:docs/superpowers/specs/2026-07-19-vendo-v2-general-quality-design.md).
The Kit is on main (#415, packages/ui kit module). Jail internals:
packages/ui/src/tree/jail/runtime-entry.tsx (JAIL_MODULES, Sucrase import rewrite).

## 1 — Ambient scope (no imports)
Island code gets React + hooks, the ENTIRE Kit, charts, and `fmt` helpers in scope
automatically (react-live pattern): inject as the jail evaluation scope instead of
requiring imports. Compile rule: island source contains NO import statements — KNOWN
specifiers (react, react-dom, @vendo/kit-ish names) are silently STRIPPED (pretraining
habit), unknown specifiers are compile errors → repair. The import/loader surface
disappears. Bundle size: the Kit already ships in the runtime — expose it to the jail
scope, don't double-bundle (check the runtime-bundle.gen.ts pipeline).

## 2 — Ambient `tools` API
`await tools.<name>.<name>(args)` inside islands. Rules:
- LITERAL MEMBER ACCESS ONLY — `tools[expr]` / aliasing patterns are compile errors.
- Compiler scans island source, infers the island's tool manifest, validates every
  name against the live registry (unknown → repair), stamps the manifest into the
  canonical tree (like compiler-minted ids).
- Runtime exposes ONLY the manifest's tools to that island (least privilege); calls go
  through the EXACT same guarded pipe as tree actions (reads per read policy; mutations
  pause at the approval gate — W0's approve→resume fix means they complete after
  approval). Promise-returning; island renders pending state.
- Iframe↔runtime bridge: extend the existing postMessage seam; the runtime side
  enforces the manifest (never trust the iframe's claim).

## 3 — Retire the fear rules
Prompt: replace "LAST RESORT / never data in islands" with the spec posture — "use the
Kit when it covers the need (faster, branded); write an island for custom
visuals/logic/interaction; Kit components and tools are in scope." Keep byte caps,
TSX+default-export gates, no-network CSP. Drop the one-region scare language; keep
"never the whole app" as guidance via the tier-0/streaming economics note.

## Verify
Gates green. Unit: manifest inference (incl. adversarial: computed access rejected,
manifest mismatch at runtime blocked). Live browser (~4 dev prompts, fresh, NOT the
frozen 30) on a prod-booted host: an island that derives + renders via Kit components
w/o imports; an island calling a read tool (search-as-you-type); an island firing a
MUTATING tool → approval gate → approve → EFFECT LANDS (W0 fix, end-to-end).
Screenshots (git add -f). NEVER `next dev`. Keys → gitignored.

## Done
PR to main, self-triage, auto-merge + re-nudge (main moves fast). Worktree comment
"W4b: <one-line>". Coordinate: engine.ts prompt island section is yours; W3 owns the
TOOL-RESPONSE-SHAPES/context sections — rebase before merge.

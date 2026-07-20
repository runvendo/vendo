# W3 — semantic sync + the two laws + inline refs (branch yousefh409/vendo-w3-semantics)

RESUMABLE: commit each step. Authority: spec §Context + §The two laws + §format Data
(git show origin/yousefh409/format-gen-v2:docs/superpowers/specs/2026-07-19-vendo-v2-general-quality-design.md).
The Kit (31 components, prop classes config|copy|data, kitPrompt()) is on main (#415).
W1 verdicts: docs/verification/w1-bench/VERDICTS.md (PR #414 — merging; its
inline-refs prototype packages/core/src/wire-v2/inline-refs.ts arrives with it. If #414
is not yet on main when you start, do Parts 1-2 first and rebase to pick it up).

## Part 1 — semantics at `vendo sync`
- Field semantics per tool response field, derived at sync into a REVIEWABLE generated
  file (the .vendo/ dir pattern): `money(cents|dollars,currency)`, `date(iso|epoch)`,
  `enum(value→label)`, `id(entity)`, `percent(0-1|0-100)`, plain. Priority: host
  annotation (extend the vendo config surface minimally) → inference from field names +
  sampled values (ONCE, at sync) → plain. Wire semantics into shape cards so generation
  + compile checks + Kit format defaults consume them.
- Domain manifest: positive list of covered data domains (derived from tool
  names/descriptions at sync; host-editable in the generated file) + explicit NOT-list
  surfaced to generation as fact.
- Tool descriptions: sync generates/improves "use this when…" descriptions where hosts
  gave none (OpenAI metadata discipline).
- Generated context: replace hand-written prompt component lists with kitPrompt() (W2)
  + host catalog schemas + tools/shapes/semantics + domain manifest, program-generated.

## Part 2 — the two laws at compile
- Law 1: `data`-classed props (Kit prop classes + host catalog schemas) must be
  bindings/tool references — literal business data = compile error → structured repair
  (W4a's, on main). Value slots typed raw via semantics (cents ⇒ number), so
  pre-formatted money strings fail type-check. Keep copy props free.
- Law 2 additions: control-grounding (action-feeding controls must match real tool
  input params — partially exists from #388; verify + extend to Kit Form/Button),
  mutation-payload rule (exists; verify against Kit components).
- Demo/preview data enters via a declared sample source, never literals.

## Part 3 — ADOPT inline tool refs (W1 Exp1 verdict)
- Enable `inlineRefs` in the production engine path (prompt teaches inline references;
  compiler pre-transform mints queries + dedupes). `<Query>` stays accepted (no break).
  Update the WIRE DIALECT prompt section accordingly.

## Verify
Gates green. Live: ~6 dev prompts (NOT the frozen 30; author fresh) through the real
engine on one prod-booted host — confirm semantics reach the prompt, Law-1 rejects a
literal-data attempt (unit test), inline refs used by the model, formatted money/dates
from Kit defaults. Screenshots (git add -f). Boot recipe:
docs/verification/vendo-v2-heldout/TASK-MAPLE.md on origin/yousefh409/vendo-heldout-maple.
NEVER `next dev`. Keys /Users/yousefh/orca/workspaces/flowlet/.env → gitignored.

## Done
PR to main, self-triage AI reviewers, auto-merge + update-branch (main moves fast —
re-nudge). Worktree comment "W3: <one-line>".

# Init AI unification: theme rides the staged extraction pass

**Date:** 2026-07-20
**Status:** Approved (Yousef, 2026-07-20)

## Problem

`vendo init` carries two contradictory AI postures:

- The tool-extraction AI pass is self-contained by intent: consent-gated,
  staged Claude Agent SDK sessions, credential = Claude Code login or
  `ANTHROPIC_API_KEY`, SDK resolved from the CLI first. But the SDK is not
  actually a dependency of anything, so in practice the pass silently skips
  (`availability()` returns null) unless the host coincidentally has
  `@anthropic-ai/claude-agent-sdk` installed.
- The theme LLM fallback rides the devModel ladder: four resolution rungs,
  three provider packages, every rung (including the Vendo Cloud gateway)
  requiring an `@ai-sdk/*` package installed in the host app. It fires
  without consent whenever a key resolves.

Consequence in the wild: on a host that is not already an AI app, neither AI
half runs. The corpus proves the DX gap indirectly: the harness works around
it by injecting `@ai-sdk/anthropic` into every cloned repo's package.json
(`corpus/harness/src/local-pack.ts`), which real `vendo init` users do not
get. With that injection the theme model pass does run nightly; the
tool-extraction Agent SDK pass still never runs anywhere (the SDK is in no
dependency tree). The four dev-set repos scoring 2/7 on theme (umami,
cal-com, formbricks, openstatus) are genuine extraction quality gaps on
thin-evidence apps, not a dead code path.

Once theme moves behind the consent gate, the corpus sweep must pass the
consent flag or nightly theme model coverage regresses. After the SDK ships
with the CLI, the harness's `@ai-sdk/anthropic` injection becomes removable
(coordinate separately; harness code is another lane's surface as of
2026-07-20).

## Decisions (locked in brainstorm)

1. **Shared consent gate.** The theme model call moves behind the same
   consent as the tool-extraction pass (`--ai-polish` or the interactive
   yes). Declining leaves exact reads plus visible defaults.
2. **Theme becomes a pipeline stage.** Not a standalone call, not raw fetch.
   Same harness, same credential story, same artifact trail.
3. **Corpus wiring ships in the same program.** Scores stay informational,
   not a hard gate.
4. **PATH-CLI harness instead of shipping the SDK** (revised 2026-07-20
   after measurement, Yousef's call). Shipping `@anthropic-ai/claude-agent-sdk`
   was measured at ~245 MB per host install: the SDK's platform packages
   each bundle the full Claude Code native binary (~241 MB), `query()`
   hard-requires it, and `optionalDependencies` only changes failure
   tolerance, not footprint. It also peers on zod 4 against our zod 3
   pins. So the SDK stays unshipped. Instead, a second
   `ExtractionHarness` drives the dev's own `claude` CLI headless
   (`claude -p`, read-only tools, isolated settings) — zero install
   weight, same credential story (Claude Code login or
   `ANTHROPIC_API_KEY`). The Agent SDK harness remains first choice when
   the SDK happens to be resolvable; the CLI harness is the fallback that
   makes the pass real for the typical dev, who has Claude Code on PATH.
   CI/corpus get the binary via `npm install -g @anthropic-ai/claude-code`
   (the nightly's MCP leg already does exactly this).

## Design

### extract-theme.ts goes fully deterministic

Keeps: context gathering (layout, CSS import graph, tailwind config),
CSS-var parsing, allowlist exact pass, per-slot validators
(`validateSlotValue`), assembly with provenance (`matched`, `defaulted`).

Deletes: `modelPass`, the `generateObject` and `ai` imports, the
`resolveModel` option, and the dead `synthetic`/`inferred` fields on
`CssVarDecl`.

Returns additionally: the `needed` slot list and the CSS evidence paths, so
the stage prompt can be composed without re-walking the tree.

### New theme stage in the staged extraction pipeline

Position: after brief (survey, draft per surface, cross-check, brief,
theme). Skipped entirely when the allowlist filled every core slot, so
conventional shadcn/Tailwind apps stay zero-AI and zero-cost.

Stage instructions carry: needed slots, already-exact values, evidence file
paths as starting hints, and the existing judgment rules (status colors are
never the accent, monochrome brands, next/font semantics, no invented
values, uncertainty only on genuine forks). The agent may Read/Glob/Grep
further on its own.

Artifact: the existing zod `modelThemeSchema` (slots plus `uncertain`),
written to the stage artifact dir like every other stage.

Apply guards, mirroring the overrides guards: only `needed` slots accepted
(exact reads always win), every value through `validateSlotValue`,
`uncertain` filtered to reviewable slots that the exact pass left open.

### init flow

- Main flow writes the exact-only `theme.json` early. The existing law is
  unchanged: a pre-existing `theme.json` is never overwritten.
- After a consented AI pass: reassemble (exact wins over model, model over
  derivation, derivation over default), rewrite `theme.json` only if init
  created it this run, print the final palette with provenance, then run
  the uncertain-slot review (`--theme slot=value` still pre-answers;
  non-interactive keeps extracted values).
- The devModel ladder leaves init entirely. It stays untouched for runtime
  `createVendo`, and `vendo refine` keeps `resolveRefineModel`. Scope
  boundary: init only.

### Degradation (visible, never silent)

- No consent: exact plus derivations plus defaults, reported in
  `defaulted`.
- Consent, no credential: the existing honest skip message.
- Stage failure: pipeline degradation note; the exact-based theme stands.
- Validator rejection: the slot defaults and is listed.

### Corpus and tests

- Corpus init-step passes the consent flag. The packed CLI now carries the
  SDK; the workflow's `ANTHROPIC_API_KEY` powers the pass. Nightly then
  measures exact-or-model on foreign repos for the first time, for both
  theme and tool extraction.
- Re-baseline theme expectations where the model genuinely recovers values
  (umami, cal-com, formbricks, openstatus candidates). Evidence-driven
  during implementation; scores stay informational.
- Port `extract-theme.live.test.ts` to the harness path, same rubric: at
  least 6/7 brand slots per demo app, any miss visible.
- Unit tests: stage parsing and apply guards through the scripted-harness
  seam; init consent semantics (gated, declined, credential-less).

## Accepted costs

- Nightly corpus spend rises: an agentic theme stage per repo, only when
  the allowlist leaves core slots open.
- Init-with-consent gets slower on non-conventional apps (an agentic stage
  instead of one structured call), traded for one mechanism and the shared
  credential story.
- The AI pass depends on a `claude` binary on PATH (or a resolvable Agent
  SDK) at init time; hosts without either keep today's honest skip. Zero
  install weight was chosen over universal availability.

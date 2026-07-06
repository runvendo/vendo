# Vendo CLI UX redesign

Date: 2026-07-05. Status: approved by Yousef (this session).

## Problem

1. `vendo init` without a provider key silently skips tools/components extraction, and
   there is no working path to fill them in later: a plain re-run exits 1
   ("theme.json already exists"), and `--force` clobbers hand-edited `.vendo/` files.
2. LLM steps run 10 to 60 seconds with zero output; users think init hung.
3. Making site widgets remixable (`<VendoRemix>` anchors) is fully manual and
   undocumented in the CLI; importing components to the agent catalog is an
   all-or-nothing LLM guess with no human selection.
4. Output across commands is inconsistent plain text; `--version` is hardcoded;
   docs do not cover the re-run story; CLI README is stale (Anthropic-only wording).
5. Verified bugs: route scan proposes tools for Vendo's own generated route;
   component codegen can emit an empty `z.enum([])` that rejects every render.

## Design

### Command surface

Six commands: `init`, `refresh` (new), `sync`, `doctor` (new), `publish`, `telemetry`.
The user story is three tiers:

- `init`: the beginning. Run once to set up.
- `refresh`: the catch-up. Run whenever the app has grown; offers only what is new.
- `sync`: the automatic in-between. Keeps existing things working on every build;
  never suggests new things.

`init` and `refresh` share one additive code path: re-running `init` on a wired app
behaves exactly like `refresh` (never fails, never overwrites). `--version` reads the
real package version injected at build time. Unknown commands print short usage
and exit 1. Help text rewritten, grouped: "you run these" (init, refresh, doctor),
"runs automatically in your build" (sync), "coming with the registry" (publish).

### init and refresh: the interactive wizard

`init` runs all steps; `refresh` runs the same pipeline in catch-up mode (steps 1
through 4 against only-new candidates, wiring verified but not re-explained).
Additive, never clobbers. Steps:

1. **Key prompt.** If no provider key is set (env or `.env.local`), prompt to paste
   one. Provider auto-detected from key format (Anthropic / OpenAI / Google),
   validated with a one-token test call, written to `.env.local`. Enter skips:
   deterministic mode plus a coaching line saying re-running init fills the gaps.
2. **Theme + tools extraction.** As today, plus: route scan excludes
   `app/api/vendo/**`.
3. **Catalog picker.** LLM proposes wrappable components, each with a one-line
   reason. Checkbox multi-select by component name (never file paths). Picked ones
   get descriptor + sandbox wrapper generated under `.vendo/components/`.
4. **Remix picker.** LLM proposes widget-shaped client components users may want to
   customize on the site, with suggested id/label. Picked ones get wrapped in a
   `<VendoRemix id label>` anchor in the host source. The LLM only selects the
   target JSX element; the edit itself is a deterministic AST splice (same
   never-guess contract as the layout wrap: skip with manual instructions when
   ambiguous; syntax-check the result). No `context` prop is guessed; each anchor
   prints a TODO pointing at the remix docs (anchors without context fall back to
   DOM-snapshot baselines, which work).
5. **Next.js wiring.** Unchanged mechanics.

Additive re-run rules, per artifact:

- `theme.json`: keep if present; extract if missing.
- `tools.json`: extract if missing or still deep-equal to the empty fallback
  `{version:1, tools:[], events:[]}`; otherwise keep.
- Components/anchors: only unwrapped/unanchored candidates are proposed;
  existing ones untouched.
- `--force`: full regenerate, with an explicit warning listing what it overwrites.

Non-interactive (`--yes` or non-TTY/CI): no prompts; key from env only; catalog
candidates all accepted; remix anchors skipped entirely (source edits stay
human-gated) with a hint printed instead.

### sync

Mechanics unchanged (anchor capture + sandbox environment build, deterministic).
Silent maintenance only: it never suggests new things. It reports only when
something it maintains is actually broken (an anchored file deleted, a capture
refused, a bundle build failure). Output restyled.

### doctor (new)

Deterministic health checks, no LLM: provider keys and the capabilities they
unlock; model override sanity; wiring integrity (route file, layout wrap,
vendo-root, sandbox assets present and not stale versus the CLI build,
next.config entries, deps installed); `.vendo/` state (theme/tools/component
counts; empty-fallback tools points at re-running init); storage mode
(DATABASE_URL versus PGlite dir writable); scheduler mode; telemetry status.
Warnings exit 0, hard failures exit 1.

### Output language

One new `src/ui.ts` used by every command: header line (`vendo init · app-name`),
step lines with ✓/!/× marks and dim details, spinner with elapsed time during LLM
steps that collapses into the result line, warnings indented under their step,
a Next-steps block, errors as one line plus one actionable fix line.
Built on picocolors + @clack/prompts (both inlined by the vite bundle).
Non-TTY / NO_COLOR / CI degrade to plain sequential lines, no spinner.
Commands keep injectable io/log seams for tests.

### Codegen hardening

Component wrapper generation gains a deterministic schema-validation rescue:
a generated descriptor whose schema is degenerate (for example empty
`z.enum([])`) or rejects its own example props fails validation and gets one
repair round-trip, mirroring the existing syntax-check rescue.

### Riding along

- CLI README: three-provider wording, current default model, new command list.
- Docs site: vendo-init page gains "Added an API key later?" (answer: `vendo refresh`);
  new `refresh` and remix-anchor sections; doctor in troubleshooting; quickstart updated.
- Telemetry events for new surface: key-prompt outcome, picker counts,
  anchor counts, doctor runs.

## Testing

- Decision-matrix unit tests for additive init: fresh, no-key-then-key,
  hand-edited artifacts, force.
- Wrap/anchor pipelines with MockLanguageModelV3, including the schema-rescue
  and ambiguous-splice-skip paths.
- Doctor checks against fixture apps (healthy, broken wiring, stale assets).
- Snapshot tests of plain-mode renderer output.
- Picker and key-prompt logic behind injectable prompt seams.
- Real-terminal verification on a scratch Next.js app before PR, output pasted
  into the PR (repo rule).

## Out of scope

Real publish (ENG-198), inferring the remix `context` prop, LLM steps inside
sync, interactive prompts beyond key + two pickers.

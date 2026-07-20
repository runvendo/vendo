# Init built-in agent harness: self-contained AI pass, codex driver, free-plan gateway policy

**Date:** 2026-07-20
**Status:** Approved (Yousef, 2026-07-20)
**Extends:** `2026-07-20-init-ai-unification-design.md` (theme-detect lane). Nothing
in that spec is reversed: the devModel ladder still leaves init, the theme
structured call still dies, the Agent SDK and `claude -p` harnesses stay as
built. This spec adds engines and the credential/policy story around them.

## Problem

After init AI unification, the consented AI pass (staged tool extraction +
theme stage) runs only when the dev's environment happens to carry an engine:
a resolvable Agent SDK or a `claude` binary on PATH. Two gaps:

1. **Not self-contained.** A dev with neither gets an honest skip. Everything
   the CLI needs should ship with the CLI; the user should never have to
   install something else to get the pass. Shipping the Agent SDK stays
   vetoed (measured ~245 MB per host install, zod-4 peer conflict).
2. **Free-plan token policy.** The Vendo Cloud gateway must not fund init
   inference for free orgs. Free plan: the dev brings their own Claude Code
   or API key. Paid plans: gateway inference during init is allowed and
   metered normally. The policy must be changeable without a CLI release.

## Decisions (locked)

1. **The vendo CLI ships a built-in agent engine.** The official Anthropic
   SDK (`@anthropic-ai/sdk`, a few MB, a real dependency of the CLI, never
   resolved from the host) running its agentic tool loop with vendo-provided
   read-only repo tools (Read/Glob/Grep equivalents). Not to be confused
   with `@anthropic-ai/claude-agent-sdk` (the Agent SDK), which is Claude
   Code itself packaged programmatically: same model either way, but the
   built-in engine carries our minimal tool scaffolding instead of Claude
   Code's full harness, which is what the 245 MB buys. It implements the same
   `ExtractionHarness` interface: same stages, same prompts, same consent
   gate, same artifact trail. No ai-sdk (`ai` / `@ai-sdk/*`) anywhere in init.
2. **Codex driver ships in the same program.** A harness that drives the
   dev's own `codex` CLI headless (`codex exec`, read-only sandbox), paid by
   their ChatGPT login or `OPENAI_API_KEY`. Sits after claude in the ladder.
3. **Engine ladder (automatic, first available wins):**
   Agent SDK if resolvable -> `claude` on PATH -> `codex` on PATH ->
   built-in engine. A rung that is present but cannot authenticate (for
   example claude installed but logged out with no key) falls through to
   the next rung. The built-in engine is always available; only its fuel
   can be missing.
4. **Built-in engine credentials:** `ANTHROPIC_API_KEY` directly, else
   `VENDO_API_KEY` through the console's Anthropic-compatible gateway.
   Neither present: the existing honest skip (a nothing-to-pay-with problem,
   not an install problem).
5. **Free-plan enforcement is server-side only.** Init tags its gateway
   traffic (request header carried through the Anthropic client). The
   gateway refuses init-tagged inference for free orgs with an honest
   message (use your own Claude Code or API key, or upgrade); paid orgs pass
   through and meter `llm_tokens` as normal. The policy lives as a per-plan
   flag in the console's plans data, per-org overridable via the existing
   subscription overrides. No client-side plan or entitlement checks, per
   the locked Cloud rule (gating is valid key + meter, nothing else).

## Design

### Built-in engine

Another `ExtractionHarness` implementation inside the vendo package. The
Anthropic SDK tool-runner loop executes a stage: stage instructions in, the
model iterates with the read-only repo tools, structured stage artifact out,
validated by the same zod schemas and apply guards as the other harnesses.
Tool surface is read-only and rooted at the host app directory. Base URL and
API key come from the credential resolution above; pointing the same client
at Anthropic or at the console gateway is the only difference between the
two fuels.

### Codex driver

Mirrors the claude PATH-CLI harness: availability probe on PATH, headless
non-interactive run, read-only tool policy, artifact parsed from the
machine-readable output. Extraction prompts are Anthropic-tuned; corpus runs
must validate quality on codex before the rung counts as supported, and the
rubric stays informational.

### Console gateway change (vendo-web)

The messages gateway learns to distinguish init-tagged requests. Resolution
order: valid key -> org plan -> init policy flag -> allow (meter normally) or
refuse with a structured error the CLI relays verbatim. Default flags: free
refuses, paid plans allow. Changing the policy is a console data change.

### Degradation (visible, never silent)

- No consent: unchanged (exact reads, derivations, defaults).
- Consent, no engine credential: honest skip naming every rung tried and the
  exact fixes (install/login claude or codex, set `ANTHROPIC_API_KEY`, or
  `vendo cloud login` on a paid org).
- Free org over the gateway: the server refusal, relayed verbatim.
- Stage failure: pipeline degradation note; deterministic results stand.

### Tests and corpus

- Unit: engine ladder resolution order, built-in loop through a scripted
  wire seam, codex output parsing, credential fallbacks, refusal relay.
- Console: gateway policy matrix (free/paid x tagged/untagged), meter still
  ingests on allowed init traffic.
- Corpus: existing claude-path baselines unchanged; add a codex leg and a
  built-in-engine leg (the harness's `@ai-sdk/anthropic` injection becomes
  removable once the built-in engine ships, since the CLI now carries its
  own client). Scores stay informational.

## Sequencing

Rides after the theme-detect lane's harness/stage work and the api-detect
lane's held init-wiring tasks land on main; the console change is a separate
vendo-web PR that can land any time before the CLI rungs ship. Coordinate
with the theme-detect lane before touching harness files on its surface.

## Accepted costs

- The vendo package grows by the Anthropic SDK (a few MB, bounded, audited).
- Built-in engine quality may trail Claude Code on repo navigation; corpus
  measures the gap and the ladder prefers real agent CLIs when present.
- Codex support carries prompt-portability risk; gated on corpus evidence.
- Paid orgs can spend metered `llm_tokens` on init (their choice, honest
  meter); free orgs get a refusal instead of a surprise spend.

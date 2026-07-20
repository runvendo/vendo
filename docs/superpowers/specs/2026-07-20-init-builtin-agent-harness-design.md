# Init self-contained AI pass: npx engine package, codex driver, free-plan gateway policy

**Date:** 2026-07-20
**Status:** Approved (Yousef, 2026-07-20; engine revised same day from plain-SDK
loop to npx-fetched Agent SDK after review)
**Extends:** `2026-07-20-init-ai-unification-design.md` (theme-detect lane).
Nothing in that spec is reversed except the shape of the last engine rung: the
devModel ladder still leaves init, the theme structured call still dies, the
Agent SDK and `claude -p` harnesses stay as built. This spec adds the
self-contained engine, the codex driver, and the credential/policy story.

## Problem

After init AI unification, the consented AI pass (staged tool extraction +
theme stage) runs only when the dev's environment happens to carry an engine:
a resolvable Agent SDK or a `claude` binary on PATH. Two gaps:

1. **Not self-contained.** A dev with neither gets an honest skip. Everything
   the CLI needs should come with the CLI; the user must never be told to
   install something else. But shipping the Agent SDK as a normal dependency
   stays off the table: measured ~245 MB per host install (its platform
   packages bundle the full Claude Code binary; `query()` hard-requires it),
   and vendo is a library inside the host app, so its dependencies land in
   every install, CI run, and production image.
2. **Free-plan token policy.** The Vendo Cloud gateway must not fund init
   inference for free orgs. Free plan: the dev brings their own Claude Code,
   codex, or API key. Paid plans: gateway inference during init is allowed
   and metered normally. The policy must be changeable without a CLI release.

## Decisions (locked)

1. **The heavy engine ships as a separate npx-fetched package, not a
   dependency.** A generic engine package (working name `@vendoai/engine`)
   carries `@anthropic-ai/claude-agent-sdk` as its only substantial
   dependency and exposes a thin runner: harness job in, stage artifacts
   out. When init needs it, the CLI invokes it via `npm exec` at a pinned
   version; npm caches it on the dev's machine (~245 MB, first run only,
   with a visible download notice). The host app's package.json,
   node_modules, builds, and CI never see it. The npx isolation also
   sidesteps the SDK's zod-4 peer conflict with our zod-3 pins.
2. **The engine package is command-agnostic.** It contains no init logic:
   the harness interface, engine ladder, prompts, and stage logic all live
   in the vendo package. Init is the first caller; `refine`, future
   `sync`/drift, or any later AI command reuse the same ladder and the same
   cached download. Out of scope now: this program wires init only;
   `resolveRefineModel` stays untouched (boundary locked in the unification
   spec).
3. **No plain-SDK loop.** The earlier idea of a hand-rolled
   `@anthropic-ai/sdk` tool loop is dropped: the engine everywhere is real
   Claude Code (dev's own binary or the npx-fetched Agent SDK), so there is
   one prompt surface, one quality bar, and no DIY agent scaffolding to
   maintain.
4. **Codex driver ships in the same program.** A harness that drives the
   dev's own `codex` CLI headless (`codex exec`, read-only sandbox), paid by
   their ChatGPT login or `OPENAI_API_KEY`. Supported only once corpus runs
   validate extraction quality on it; scores stay informational.
5. **Engine ladder (automatic, first available wins):** Agent SDK if already
   resolvable -> `claude` on PATH -> `codex` on PATH -> npx engine package
   (auto-download). A rung that is present but cannot authenticate (for
   example claude installed but logged out with no key) falls through to the
   next rung. The npx rung fails only offline or credential-less, which
   degrades to the honest skip.
6. **Engine credentials:** the dev's own Claude Code login or
   `ANTHROPIC_API_KEY`; else `VENDO_API_KEY` through the console's
   Anthropic-compatible gateway (Claude Code honors `ANTHROPIC_BASE_URL` and
   `ANTHROPIC_AUTH_TOKEN`, so gateway fuel works for both the PATH claude
   rung and the npx engine).
7. **Free-plan enforcement is server-side only.** Init tags its gateway
   traffic (request header, via Claude Code's custom-headers support). The
   gateway refuses init-tagged inference for free orgs with an honest
   message (use your own Claude Code or API key, or upgrade); paid orgs pass
   through and meter `llm_tokens` as normal. The policy lives as a per-plan
   flag in the console's plans data, per-org overridable via the existing
   subscription overrides. No client-side plan or entitlement checks, per
   the locked Cloud rule (gating is valid key + meter, nothing else).

## Design

### Engine package

A new published package whose runner accepts a serialized harness job
(stage instructions, tool policy, artifact schema reference, credential env)
and executes it through the Agent SDK, returning stage artifacts on stdout
or the artifact dir. Pinned invocation from the CLI (exact version, not a
range). Read-only tool policy rooted at the host app directory, isolated
settings so the dev's personal Claude Code config does not leak in. The
download moment is explicit in init output: what is being fetched, how big,
that it is cached for next time.

### Codex driver

Mirrors the claude PATH-CLI harness: availability probe on PATH, headless
non-interactive run, read-only tool policy, artifact parsed from the
machine-readable output. Prompt-portability risk is real (prompts are
Anthropic-tuned); the corpus codex leg decides when the rung counts as
supported.

### Console gateway change (vendo-web)

The messages gateway learns to distinguish init-tagged requests. Resolution
order: valid key -> org plan -> init policy flag -> allow (meter normally)
or refuse with a structured error the CLI relays verbatim. Default flags:
free refuses, paid plans allow. Changing the policy is a console data
change, no CLI release.

### Degradation (visible, never silent)

- No consent: unchanged (exact reads, derivations, defaults).
- Consent, offline or no credential on any rung: honest skip naming every
  rung tried and the exact fixes (log into claude or codex, set
  `ANTHROPIC_API_KEY`, or `vendo cloud login` on a paid org).
- Free org over the gateway: the server refusal, relayed verbatim.
- Stage failure: pipeline degradation note; deterministic results stand.

### Tests and corpus

- Unit: engine ladder resolution order (including auth fall-through), npx
  invocation seam (scripted, no real download), codex output parsing,
  credential fallbacks, refusal relay.
- Console: gateway policy matrix (free/paid x tagged/untagged), meter still
  ingests on allowed init traffic.
- Corpus: existing claude-path baselines unchanged; add a codex leg and an
  npx-engine leg. The harness's `@ai-sdk/anthropic` injection becomes
  removable once the engine rung ships. Scores stay informational.

## Sequencing

Rides after the theme-detect lane's harness/stage work and the api-detect
lane's held init-wiring tasks land on main; the console change is a separate
vendo-web PR that can land any time before the CLI rungs ship. The engine
package needs a publish pipeline entry (blocked with everything else on
NPM_TOKEN). Coordinate with the theme-detect lane before touching harness
files on its surface.

## Accepted costs

- First npx run downloads ~245 MB (network required, visible notice);
  offline devs keep the honest skip. Nothing ships in host installs.
- A second published package to version, pin, and release.
- Codex support carries prompt-portability risk; gated on corpus evidence.
- Paid orgs can spend metered `llm_tokens` on init (their choice, honest
  meter); free orgs get a refusal instead of a surprise spend.

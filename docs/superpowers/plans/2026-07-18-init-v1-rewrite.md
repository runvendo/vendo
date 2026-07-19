# vendo init v1 Rewrite — Implementation Plan

Source spec: docs/brainstorms/init-cli-dx.md (converged 2026-07-18).
Goal: ship the v1 of the redesigned init — zero-ceremony deterministic base
plus the AI extraction layer behind a swappable seam — done, tested, merged.
Bias: simple and adaptable; every block gets improved later.

Delivery: two sequential PRs, each independently green
(pnpm build && pnpm test && pnpm typecheck && pnpm lint) and each leaving a
working product.

## PR 1 — Simplify: the deterministic base

The kill list plus the new init skeleton. No AI yet; static extraction stays
as the interim tools.json source (it becomes the hints layer in PR 2).

Wave 1: runtime groundwork
- Make createVendo's `model` optional: when absent, resolve an env credential
  at runtime (provider keys, VENDO_API_KEY gateway). Amend the 09 contract.
- Remove Claude/Codex session rungs from the dev-credential resolver and
  devModel: runtime = real keys only, honest failure otherwise. Delete the
  consent-record machinery and VENDO_DEV_ALLOW_SESSIONS.
- Encryption key: remove generation from init; store rule becomes dev =
  local unencrypted, production secret-write without a host-provided key
  fails closed with a clear error, Cloud stores cloud-side. Amend 02-store §4
  and the persistence docs.

Wave 2: the new init
- Remove: 4-question interview, per-diff y/N confirm loop, remix offers and
  the recapture pass, unresolved-slot warnings in init output, refine offer,
  finale (server spawn / browser / seeded turn / paste-watch), encryption-key
  step, lib/ai.ts scaffold, layout codemod (wireLayout + defaultLayoutSource
  scaffolding of layout edits).
- New flow: scan (framework + static extraction + theme + catalog, silent) →
  wire (route file + package.json hooks only; route template omits `model`) →
  key step (env key stated in one line, else the existing cloud starter-key
  offer) → done summary (files changed, .vendo artifacts, the VendoRoot line
  to paste, "start your dev server", pointer to doctor).
- Keep: --yes, --force, --agent (plan output updated to the new shape),
  idempotent re-run behavior, server-actions map generation and rewiring,
  .claude vendo-setup skill write (silent, listed), MCP door generation stays
  but only via existing `vendo mcp` path — never asked in init.
- Express: same simplification; the "two manual steps" message becomes part
  of the done summary.

Wave 3: doctor + surface
- Doctor: remove the codex drift probe. Everything else stays (it is the
  verify/live-turn surface).
- CLI help: rewrite around init + doctor as the two human verbs; sync and
  refine remain functional but described as plumbing/advanced.

Wave 4: tests + docs
- Rewrite/remove tests tied to killed behavior (interview, confirm loop,
  dev-mode consent, finale, encryption key, remix offers in init).
- Add tests for: new init flow output, model-optional createVendo (env
  resolution + honest failure), production secret-write fail-closed rule,
  init idempotency in the new shape.
- Update docs/quickstart.md and any doc referencing killed behavior.

## PR 2 — The AI extraction layer (v1: draft + verify)

Architecture per spec: Vendo owns instructions + verification + artifact
contract; the coding agent is behind a seam.

Wave 5: the seam and the harness
- ExtractionHarness interface (one thin seam): run instructions with a
  workspace + tool access, return draft artifacts. Nothing above the seam
  assumes a vendor.
- V1 harness: Claude Agent SDK as a CLI dependency (never the host app's),
  driven headless. Credential = whichever the user picked.
- Credential choice prompt in init: options detected on the machine — Claude
  Code login / Anthropic API key / free Vendo starter key (gateway) / skip
  (static extraction only). Choice doubles as consent; one honest line about
  source going to the chosen provider; secrets filter on file access.

Wave 6: draft + verify
- Draft instructions (v1, single staged pass): read the codebase with static
  extraction output as hints; emit tools.json entries (name, description,
  params, risk with reasoning) and brief.md. Narrated progress (surfaces
  discovered, streamed to the terminal).
- Verification: when a dev server is reachable, exercise read tools and
  shape-verify writes (invalid payload → expect validation error);
  per-tool verification policy kept adaptable. No server → drafts land
  marked unverified, doctor verifies later.
- Failures ship disabled with the model's explanation; never silently drop.

Wave 7: tests + evals + docs
- Unit tests against a fake harness (seam contract, artifact validation,
  verification logic, skip path, no-credential path).
- One live smoke path documented (corpus fixture) as the manual eval; full
  corpus eval matrix is a follow-up, not v1.
- Docs: quickstart extraction section, .vendo artifact documentation.

## Out of scope (deferred, recorded in the spec)
- Browser finale ceremony; external-agent delegation (--agent unification,
  Cursor, skill-as-harness); sync/drift triage design; staged 5-pass
  pipeline; corpus eval matrix; Cloud starter-key minting endpoint
  (vendo-web repo — CLI already degrades gracefully when absent); Express
  agent-assisted wiring; remix candidate suggestions in doctor.

## Merge protocol
Each PR: green on the four commands, opened against main, CI green,
AI-reviewer feedback triaged, then merged (Yousef pre-authorized completion
through merge for this lane). PR 2 lands only after PR 1 merges.

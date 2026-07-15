# Install DX Implementation Plan

> Executed wave-by-wave by codex sol under Fable orchestration (Opus 4.8 only when
> sol is blocked). Spec: `docs/superpowers/specs/2026-07-14-install-dx-design.md` —
> read it first; it holds every locked decision. This plan is deliberately
> high-level (team rule): goals, steps, decisions — the executor owns the code.

**Goal:** `npm install vendoai` → `npx vendo init` → a working, on-brand agent
visible in the dev's own product before the terminal closes, for humans and
agents alike.

**Architecture:** Extend the existing well-tested CLI backbone (wizard, doctor,
sync) with a dev-mode model-credential ladder, an init-ends-in-product finale,
cloud starter-allowance rung, and agent-facing surfaces. Publish the real 0.3.0
artifact first so every subsequent test runs against what devs actually install.

**Cross-cutting rules (every wave):**
- Branch + PR per wave; never commit to main. `pnpm build && pnpm test &&
  pnpm typecheck && pnpm lint` green before any PR.
- UI-affecting changes verified in a real browser with screenshots in the PR.
- Each wave ends with a captured real demo of its outcome, not just tests.
- Contracts in `docs/contracts/` are frozen; layering guard must stay green.

---

## Wave 1 — Publish 0.3.0 + npm hygiene (unblocks everything)

Outcome: the product the repo describes is installable from npm; npm page looks
intentional; stale 0.1.0 line is deprecated.

1. Publish preflight in-repo: per-package READMEs included in tarballs (root
   README-derived for the umbrella + alias; short block READMEs elsewhere);
   `files` arrays complete; verify the `vendoai` alias's workspace dep rewrites
   to a real version on pack; run a pack-and-install rehearsal into a fresh app
   from local tarballs (no registry) and drive init + doctor.
2. Drift fixes that ship with the publish: CLI help "three questions" vs docs
   "four"; document `--yes/--force/--model-import/--brief` and sync's `[dir]`
   positional; make sure nothing generated pins floating `latest` or references
   nonexistent packages (the 0.1.0 ghost-dep class).
3. Deprecation plan for the eleven 0.1.0-era packages (cli, client, components,
   core→superseded-by-new-core note, react, runtime, server, shell, stage,
   store, telemetry): deprecation messages pointing at `vendoai`/docs. Old
   `vendoai@0.1.0` itself gets superseded by the new version, not deprecated.
4. **Yousef-run publish step** (passkey 2FA cannot run in a sandbox): hand him
   the exact command block (pnpm recursive publish, `--access public`,
   `NPM_CONFIG_MIN_RELEASE_AGE=0` to dodge his `min-release-age=7` npmrc), plus
   the deprecate commands. Expect several minutes of anonymous-GET propagation
   lag before verification.
5. Post-publish clean-room verification from the live registry: fresh Next app,
   `npm install vendoai` and `npm install @vendoai/vendo` both → init → doctor.
   Capture terminal recording; this is the wave demo.

Acceptance: both package names install from npm; init + doctor complete on a
fresh app; npm pages show real READMEs; 0.1.0 packages display deprecation
notices; drift fixes merged.

## Wave 2 — Model ladder + dev-mode runtime + init ends in the product

Outcome: zero-key first turn in the dev's browser at the end of init.

1. **Spike (timeboxed ~1 day, decision gate with orchestrator before build):**
   persistent-process ai-SDK providers over Claude Agent SDK and Codex
   app-server, with Vendo's host tools bridged via in-process MCP and consent
   routed through the permission callback. Measure interactive latency and
   verify approval semantics survive. Report recommends: full-tools riding /
   tools-free riding fallback / key-rungs-only.
2. Credential resolver: detect env keys, authed Claude session, authed Codex
   session, VENDO_API_KEY — in that order (env first; explicit beats implicit).
   Wizard states what it found; consent before any CLI-session use; resolver
   output shared by runtime dev-mode and extraction `--deep`.
3. Dev-mode runtime model wiring per rung, prod-vs-dev distinction, and the
   explicit "production needs a real key" messaging in init next-steps.
4. Init finale: consent-gated start of the dev server, open browser on the host
   app, adaptive seeded first turn (tools → tool demo; theme-only → on-brand
   UI generation; blank → self-aware tour).
5. E2E: clean-room fresh app + each ladder rung exercised (env key, claude
   session, codex session, none) with captured outcomes.

Acceptance: on a keyless machine with an authed claude or codex CLI, init ends
with a real agent reply rendered in the browser; every rung's behavior tested;
wave demo GIF captured.

## Wave 3 — Doctor v2 + cloud-in-init

Outcome: doctor proves a user would get an answer; cloud is a first-class rung.

1. Doctor: one real model turn through the wired route printed in the terminal
   (exit 0 = answered); `--json`; consent-gated "start the dev server for the
   probe?" when nothing is listening; VENDO_API_KEY validation + what it
   unlocks in the ladder hints.
2. Cloud in init: detect + validate VENDO_API_KEY; offer `vendo cloud login`
   inline (browser OAuth).
3. Starter allowance (built here, in vendo-web console): endpoint + key
   semantics for minting a metered dev-mode key after login; wizard writes
   `.env.local` itself. Coordinate schema with the Cloud console project but do
   not wait on it.

Acceptance: doctor exit 0 ⇔ live answered turn; doctor --json consumed by a
script in tests; keyless dev completing `vendo cloud login` inside init gets a
working first turn on the allowance key; wave demo captured.

## Wave 4 — Agent surfaces

Outcome: an agent pointed at a repo (or the paste prompt) completes the install.

1. install.md: single canonical staged playbook (base install → review/remix →
   block unlocks) as a docs-site page served at a stable URL + raw .md; the
   3-line paste prompt references it.
2. llms.txt + per-page .md on the docs site.
3. Vendo setup skill: authored once, shipped in the npm tarball; init offers
   (consent) to write it to the host repo's `.claude/skills/`; published to
   skills.sh.
4. Machine-readable CLI completion: `sync --json`; `init --agent` enriched to
   include extracted tools + risk recommendations (run extraction before
   emitting the plan).

Acceptance: a fresh Claude Code session given only the 3-line paste prompt
completes install through doctor-green on a clean app, captured end-to-end;
llms.txt validates; skill installs via both routes.

## Wave 5 — Demos, GIFs, CI guard

Outcome: the marketing-grade and honesty-grade proof set, plus permanent drift
insurance. All captures against the PUBLISHED package.

1. Fresh Next starter GIF: install → init → doctor → browser first turn.
2. De-wired Maple clone GIF: copy demo-bank, strip Vendo wiring + .vendo/, run
   the full journey — extraction + on-brand theming wow.
3. One corpus repo run (real OSS app) — honest proof, terminal + browser capture.
4. Agent-driven install GIF (from wave 4 acceptance, re-captured at final
   quality if needed).
5. CI clean-room guard: recurring workflow installing the published package
   into a fresh app, running init + doctor + one real turn; fails loudly on
   npm-vs-main drift.

Acceptance: four GIFs + corpus capture reviewed by Yousef; CI guard green on
schedule and proven to fail on a simulated drift.

---

## Sequencing & orchestration

Wave 1 strictly first. Waves 2 and 4 can overlap after 1 (different surfaces);
wave 3 follows 2's resolver; wave 5 last. Publish and any credential-sensitive
step is Yousef-run. Each wave: codex sol executes → orchestrator reviews →
code-review pass → PR → Yousef merge. Spike results and any spec deviation come
back to Yousef before proceeding.

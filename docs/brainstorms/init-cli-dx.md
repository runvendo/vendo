# Brainstorm: vendo init / CLI DX

Status: CONVERGED (Yousef + init-cli lane, 2026-07-18)

## Goal

One command, about a minute, zero questions on the happy path: `npx vendo init`
ends with the dev's own product answering a first agent turn in their browser.
Everything that is not required to reach that moment leaves init.

## The foundational decision: extraction is AI-native

The biggest outcome of this brainstorm. Understanding a host's API surface is
model work, not regex work (proof points: Okibi drafts CLIs from arbitrary
codebases with AI plus build/test verification; PostHog's wizard does the
semantic integration work with an agent). The deterministic extractor went
static-only because no model credential existed at setup time. The new init
resolves a credential before extraction, so that constraint is gone.

New architecture: **AI-drafted, deterministically verified, committed.**

- An agent reads the codebase and drafts tools.json: real names, real
  descriptions, semantic risk grades. No more "host_x_unclassified".
- The existing static extractors demote to hints fed to the agent, and remain
  the trivial path for self-describing surfaces (OpenAPI, GraphQL, tRPC).
- Every drafted tool is verified deterministically (probed against the running
  dev server; typechecked where possible) before it lands. Unverifiable tools
  ship disabled with the model's explanation.
- The result is a reviewed, committed artifact. Runtime and builds never call
  a model. Sync demotes to drift detection: code changed under a tool, so
  re-draft that tool only.

Engineering doctrine (both proof points say this is the hard part):

1. Agent loop, not one-shot completion (PostHog v1 failed at ~80/20 with no
   verification; fixed by Claude Agent SDK plus staging plus verification).
2. Staged pipeline: discover surfaces, draft per-surface, grade risk, draft
   brief. Narrow instructions per stage.
3. Deterministic verification always. Never cross fingers.
4. Eval harness first: the existing 12-repo corpus with layered pass@k scoring
   becomes the AI extractor's benchmark. This is an unfair advantage; Okibi and
   PostHog built theirs from scratch.
5. Committed artifact, AI-free runtime.

## The new init

Five steps, zero questions on the happy path:

1. **Wire.** Init writes exactly one file (the catch-all agent route) and adds
   two package.json script hooks. It never edits user-authored code: the
   one-line VendoRoot layout wrap is the user's to paste, guided at the finale
   (init prints the line, watches for the hot reload, then opens the browser).
   No lib/ai.ts scaffold: createVendo's `model` becomes optional and resolves
   the env/starter key itself; a model module is a documented escape hatch for
   BYO-LLM only. No gates, no per-file y/N, no git ceremony.
2. **Get a key.** Env key if present (one line, done). Otherwise offer the
   cloud starter key: browser login, Vendo Cloud mints a metered dev key and
   writes it to .env.local. The dev never pastes a key. This is the only
   fallback; production always needs the dev's own key.
3. **AI extraction.** The agent reads the product and drafts tools.json plus
   brief.md (see above). Replaces both the old interview and the old
   refine-as-separate-command for the first-run case.
4. **Launch.** Start the host dev server, open the browser.
5. **First turn — in the browser.** Guided layout paste (init prints the
   VendoRoot one-liner, watches for the hot reload), then the browser opens
   with a pre-seeded thread already answering: the agent introduces itself
   inside the product, in the host brand, from a model-written toolbox. The
   terminal just points at it. Seed stays adaptive (tools demo / on-brand UI /
   tour). Decided; details deferred until the core works.

Total interaction: one keypress (yes to the starter key) plus a browser login;
zero when an env key exists.

## Decisions made with Yousef

- **Kill the 4-question interview.** Model import is detected; the brief is
  AI-drafted; risk marking is AI-proposed; the MCP door question leaves init
  (it stays a deliberate post-setup step via the existing `vendo mcp` flow).
- **Kill per-diff y/N approvals.** Apply and list the files changed. No
  full-file "diffs", no git gates or messaging.
- **Kill the session-rung runtime ladder.** The Claude Code / Codex login was
  never meant to serve product turns. Runtime model = real keys only (env key
  or minted starter key). The Claude session's proper place is init-time
  assistance only: ephemeral, nothing installed into the host app, never
  serving a product turn.
- **Kill the store encryption key from init.** Dev mode stores locally with no
  key and no output line. Production secret-writes without a dev-provided key
  fail closed with a clear message; with Vendo Cloud, secrets live cloud-side.
  Same symmetric story as the model key: dev needs nothing, production needs
  your keys. (Contract amendment: 02-store section 4 default-on encryption
  becomes the prod-owned rule; contracts are unfrozen for v2.)
- **Human command surface = init + doctor.** Sync demotes to plumbing
  (predev/prebuild hooks plus the CI strict gate; not a headline command).
  Refine stops being a command a human must discover: its engine is absorbed
  into AI extraction (first run) and doctor (ongoing suggestions, e.g. "3
  tools drifted, want me to re-draft them?"). "Run vendo init again" stays the
  answer for structural drift; init is already idempotent.
- **Re-running init** is the one story for "my code changed a lot".

## Cleanup list (implementation work items)

- VENDO_STORE_ENCRYPTION_KEY: remove generation from init.ts; new runtime rule
  in server.ts; amend docs/contracts/02-store.md, persistence-and-deploy.md,
  store README.
- Session rungs: remove claude-session/codex-session from the dev-creds
  resolver, dev-mode.ts consent flow, .vendo/data/dev-credential.json,
  VENDO_DEV_ALLOW_SESSIONS, the SDK devDependency install prompt, and the
  codex drift probe in doctor.
- Interview: remove the 4-question flow and --brief/--ask surface tied to it.
- Per-diff confirm flow: remove; replace with the changed-files summary.
- Remove the layout codemod (wireLayout) and the lib/ai.ts scaffold; make
  createVendo's `model` optional with env/starter-key resolution as default;
  build the finale's paste-and-watch step for the layout line.
- Remove remix offers from init entirely (remixWrapChanges, the re-sync
  recapture pass, and unresolved-slot warnings in init output). Component side
  of init = silent catalog discovery + theme extraction only. `remixable:
  true` is a documented user opt-in; suggesting candidates is judgment work
  that can live in doctor later.
- Refine offer and finale ordering: finale is the guaranteed ending; no
  pre-finale refine offer.
- Build the Cloud starter-key minting endpoint (was already a parked follow-up;
  now on the critical path of step 2).

## What stays

- The finale (dev server, browser, seeded adaptive first turn): best-in-class,
  now the guaranteed ending of init.
- doctor: the health verb, plus the new home for ongoing AI suggestions.
- --agent mode: stays first-class (PostHog validates agent-driven installs);
  gets simpler because it prints the plan the AI pass would execute.
- The corpus harness: repurposed as the AI extractor's eval benchmark.
- Static extractors: as hints and the fast path for self-describing surfaces.

## How the AI extraction works (brainstormed 2026-07-18)

Base first: v1 implements the simplest correct version; the standing goal is
to keep improving the AI quality after. Do not overbuild v1.

- **Harness: existing agent machinery, provider-agnostic.** No bespoke loop
  and no external framework. The ai-SDK's agent primitives on the
  LanguageModel seam, reusing @vendoai/agent's loop machinery with an
  extraction toolset (read file, grep, probe endpoint, emit draft). Any
  provider plugs in; this matches Vendo's BYO-LLM identity. Claude Agent SDK
  and other provider-locked or competitor frameworks rejected.
- **Credential (init-time only, decoupled from runtime):** Claude Code /
  Codex session adapters (ephemeral init help, nothing installed into the
  host app), any BYO key, starter key through the gateway as the floor. The
  runtime agent's key is a separate concern.
- **Verification:** reads are fully exercised against the running dev server;
  writes are shape-verified (invalid payload in, proper validation error out
  proves route + schema without mutating). Verification level is an
  adaptable per-tool policy, not hardcoded. Nothing enters tools.json
  unverified; failures ship disabled with the model's explanation.
- **No time budget.** Quality first; the extraction narrates progress live
  (the discovered-surfaces tree is the loading state). Once-ever setup cost;
  the v2 <10s bar applies to runtime generation, not this.
- **Privacy:** on session/BYO paths, source goes to the dev's own provider
  account. One honest line up front plus a secrets filter (PostHog posture).
- **Pipeline:** v1 = draft + verify, kept inspectable. The staged shape
  (survey, draft per surface, cross-check, verify, brief+seed) is the
  documented improvement path, scored per stage on the corpus harness, not a
  v1 requirement.
- **Sync/drift: deferred entirely.** v1 story for changed code is "run
  vendo init again" (idempotent). Drift triage, fail-closed rules, and CI
  strictness get designed when the base works.

## Open questions (remaining)

- Verification ordering inside init: drafting can start before the dev server
  is up, but verification needs it. Likely draft (3), launch (4), verify,
  then first turn (5). Spec-phase detail.
- Express hosts: the install agent should eventually close the "two manual
  steps remain" gap; deferred, not designed here.
- Exact v1 cut of the extraction agent (how much of the staged pipeline lands
  first) — sequencing call for the coordinator/spec phase, biased simple.

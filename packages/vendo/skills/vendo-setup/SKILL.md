---
name: vendo-setup
description: Install and configure Vendo (the embedded product agent) in a host repo. Use when asked to add Vendo to an app, run vendo init/doctor/sync, wire the Vendo handler or VendoProvider, or debug a Vendo install.
---

# Vendo setup

Vendo embeds an agent inside a host product: it extracts the host's API as
tools, renders generated UI in a sandboxed brand-native surface, and acts as
the signed-in user. This skill installs and verifies Vendo in a host repo.

The canonical agent playbook lives at https://vendo.run/agents.md —
fetch it when you need more detail than this skill carries.

## Stage 1 — base install

1. Install the umbrella package (either name; `vendoai` is a thin alias):

   ```bash
   npm install @vendoai/vendo
   ```

2. Run init. It asks first, then writes:

   ```bash
   npx vendo init --agent
   ```

   Init detects the stack and prints ONE JSON object. `{"status":
   "questions", …}` means it wrote nothing: relay every `prompt` to the user
   VERBATIM in chat, with its options. Each option carries the literal thing
   you do to pick it, a `flag` for the re-run or a `command` to run first.
   Then re-run with every answer:

   ```bash
   npx vendo login --wait 90                          # only if they picked the free Cloud key
   npx vendo init --agent --use-case embedded --auth clerk --byo
   ```

   That run writes, narrates itself, and ends on the receipt, the LAST JSON
   object it prints: `{"status": "written", …}` with `wrote` (the files it
   created), `detected` (framework, auth, package manager, port),
   `guardPosture`, `continueUrl` (the ONE page carrying the instructions for
   the use case you picked), `keptUncertain`, `pendingLoosenings`, and
   `judgment`. `judgment` is `graded` with the file it wrote when a judgment
   engine resolved on this machine, and `delegated` with a checklist that is
   yours to work through when none did — read it, do not assume either. Both
   runs exit 0, so branch on `status`, never on the exit code. All answers on
   the first call and it writes in one pass.

   Never relay a mechanical question. The zod floor and the theme slots are
   never asked: they take their defaults and show up in the diff. The one
   question about SPENDING — may a coding agent read this codebase — is asked
   up front with the others, never mid-run, so a run that has started writing
   will not stop to ask you anything.

   `pendingLoosenings` is a count, not a task: a loosening (waking a disabled
   tool, lowering a risk grade) is never applied without a human, so the pass
   holds them as `pending` and nothing blocks. `vendo sync --review` is where
   a person answers them.

   **Init never edits a file a human wrote, and it prints no code.** Every file
   it writes is new and Vendo-owned, plus its own `package.json` hooks. The
   work it cannot do — mounting the visible surface, wiring your own agent
   loop, pointing an MCP client at the door — is at `continueUrl`. Fetch that
   page and follow it before calling the install done; `vendo doctor` grades
   what is still missing (`E-WIRE-004` for the mount).

3. What init does (framework detected from `package.json`, `next` beats
   `express`; with neither present it refuses to guess and asks for
   `--framework next|express|custom`):
   - Writes `.vendo/` — `tools.json` (extracted tools), `overrides.json`
     (your risk/confirmEach edits, respected forever), `policy.json`,
     `brief.md`, `theme.json` (brand extracted from the host CSS), and a
     gitignored `.vendo/data/` for the PGlite store. Commit `.vendo/`,
     never `.vendo/data/`.
   - Next.js: writes `app/api/vendo/[...vendo]/route.ts` (or under
     `src/app`) and the `lib/vendo.ts` composition over it. It writes no client
     file: mounting the provider is yours, at `continueUrl`.
   - Express: proposes `vendo/server.ts` (`.mjs` without a tsconfig); mounting
     it and wrapping the client are yours, at `continueUrl`.
   - Adds `predev`/`prebuild` sync hooks to `package.json` (consent-gated).

4. Model credential: the starter model module uses
   `createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`. Install its
   pinned peers and set the key:

   ```bash
   npm install ai@^6 @ai-sdk/anthropic@^3
   echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env.local
   ```

   Never invent a key; ask the user for one if none is set. Any AI SDK
   provider works — pass the host's own model into
   `createVendo({ model })` when one exists.

5. Verify:

   ```bash
   npx vendo doctor
   ```

   Doctor reads the repo: wiring, the `.vendo/` files, the tool catalog, and
   the model credential in your environment. It needs no running app.
   Exit 0 = green; exit 1 prints each `broken:` line. Fix and re-run until 0.
   Common fixes: missing `.vendo/*` file (re-run `npx vendo init`), layout not
   wrapped (`E-WIRE-004` — its troubleshooting page carries the exact lines;
   init will never make that edit for you).

## Stage 2 — review and keep extraction fresh

- AI judgment: run it in-band with `npx vendo sync --ai`. A coding agent
  grades the extracted catalog with a verbatim source quote behind every
  proposal, an independent skeptic checks each one, and the result lands in
  `.vendo/judgments.json`. Loosenings wait for a human (`--review` asks
  inline). `overrides.json` stays read-only prompt context meaning "what a
  person decided". There is no draft-delegation path — the judgment needs
  quoted evidence a handed-off draft cannot carry.
- Consent rule, on both `init` and `sync`: `--ai` runs the pass with no
  prompt, `--no-ai` forces it off, and with neither flag an interactive run
  asks EVERY time (nothing is saved) while a non-interactive run — CI, a
  pipe, `--json`, `--yes`, or any `npm run` lifecycle hook — skips it. As an
  agent you are non-interactive: pass the flag you mean.
- Re-extract after API changes: `npx vendo sync` (fail-soft). Sync owns the
  whole scan — tools, remix baselines, the component catalog, AND the theme
  (a rebrand in your CSS reaches `.vendo/theme.json`; slots a human edited
  are pinned and reported, `--theme-refresh` overrides). In CI use
  `npx vendo sync --strict --no-ai` — exit 2 on breaking tool changes, 3 when
  saved apps/automations/grants are impacted. `--json` emits one
  machine-readable report object on stdout.
- Review `.vendo/tools.json`; put corrections in `.vendo/overrides.json`
  (`{"tools": {"host_invoices_delete": {"confirmEach": true}}}`) — never edit
  `tools.json` by hand, sync regenerates it.
- Tighten `.vendo/policy.json` rules (`ask` for destructive, `run` for read)
  and write a real product brief in `.vendo/brief.md`.

## Stage 3 — unlocks

- **MCP door** (agents like Claude/ChatGPT use the product's tools): a host
  decision, never a default. Needs a `HostOAuthAdapter` and
  `createVendo({ mcp: true, oauth })`, then `npx vendo mcp server-json` and
  `npx vendo mcp verify-domain`. Doctor checks `server.json` and the domain
  verification file.
- **Sandbox / connectors / voice / persistence on Postgres**: see
  https://docs.vendo.run for each capability.
- **Vendo Cloud**: sharing, org overlays, and hosted automations activate
  with `VENDO_API_KEY` (`npx vendo login`).

## Rules

- Show the user every proposed code diff before applying it unless they
  explicitly asked for unattended setup.
- Do not hand-edit generated files (`.vendo/tools.json`, theme regeneration);
  use `overrides.json` and re-run sync.
- Done means the work at `continueUrl` is applied — init writes no client file
  and prints no code, so the mount (and any loop or MCP wiring) is yours, and
  that page carries the exact lines. `npx vendo doctor` is the separate,
  orthogonal check on what is on disk; init's own exit code is about init's own
  work and never about doctor.

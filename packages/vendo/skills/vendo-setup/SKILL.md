---
name: vendo-setup
description: Install and configure Vendo (the embedded product agent) in a host repo. Use when asked to add Vendo to an app, run vendo init/doctor/sync, wire the Vendo handler or VendoProvider, or debug a Vendo install until doctor exits 0.
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

2. Run init. As an agent, plan first, then apply:

   ```bash
   npx vendo init --agent   # read-only JSON plan: framework, code diffs, the `mount` paste, extracted tools, risk recommendations
   npx vendo init --yes
   ```

   `--agent` writes nothing. Init applies its bounded change set and lists
   it; the only questions are an auth confirm when detection is uncertain, a
   review of uncertain theme slots, and the end-of-init cloud-login offer
   (`--yes` skips it). Each question has a non-interactive answer flag:
   `--auth <preset>`, `--framework <name>`, `--theme <slot=value>`
   (repeatable), `--cloud-key <key>` or `--byo`, and `--ai` / `--no-ai` to
   force the AI judgment pass on or off. Prefer the interactive run when a
   human is present.

   **Init never edits a file a human wrote.** Every file it writes is new and
   Vendo-owned, plus its own `package.json` hooks. Mounting the visible
   surface is a paste YOU must apply — the plan carries it as
   `mount: { file, lines, why }` and the run prints it in a framed
   "ONE STEP LEFT" block. Apply it before calling the install done; `vendo
   doctor` fails with `E-WIRE-004` until it lands.

3. What init does (framework detected from `package.json`, `next` beats
   `express`; anything else is treated as Next):
   - Writes `.vendo/` — `tools.json` (extracted tools), `overrides.json`
     (your risk/confirmEach edits, respected forever), `policy.json`,
     `brief.md`, `theme.json` (brand extracted from the host CSS), and a
     gitignored `.vendo/data/` for the PGlite store. Commit `.vendo/`,
     never `.vendo/data/`.
   - Next.js: writes `app/api/vendo/[...vendo]/route.ts` (or under
     `src/app`). It writes no client file: mounting
     `<VendoProvider baseUrl="/api/vendo">` around `{children}` is your paste
     (see the `mount` step above).
   - Express: proposes `vendo/server.ts` (`.mjs` without a tsconfig) plus a
     starter `vendo/ai.ts`; you must still mount
     `app.use("/api/vendo", mountVendo())` and wrap the client in
     `<VendoProvider>` yourself.
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

5. Verify. Start the dev server, then:

   ```bash
   npx vendo doctor
   ```

   Doctor checks wiring plus one live `/status` round-trip against
   `http://localhost:3000/api/vendo` (override with `--url` or `VENDO_URL`).
   Exit 0 = green; exit 1 prints each `broken:` line. Fix and re-run until 0.
   Common fixes: dev server not running (start it), missing `.vendo/*` file
   (re-run `npx vendo init`), layout not wrapped (`E-WIRE-004` — paste the
   exact import + wrap lines doctor prints into the named file; init will
   never make that edit for you).

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
  `npx vendo mcp verify-domain`. Doctor validates the discovery documents.
- **Sandbox / connectors / voice / persistence on Postgres**: doctor's final
  ladder line names what each remaining block unlocks; see
  https://docs.vendo.run for each capability.
- **Vendo Cloud**: sharing, org overlays, and hosted automations activate
  with `VENDO_API_KEY` (`npx vendo login`).

## Rules

- Show the user every proposed code diff before applying it unless they
  explicitly asked for unattended setup.
- Do not hand-edit generated files (`.vendo/tools.json`, theme regeneration);
  use `overrides.json` and re-run sync.
- Done means `npx vendo doctor` exits 0 against a running dev server, not
  merely that files exist.

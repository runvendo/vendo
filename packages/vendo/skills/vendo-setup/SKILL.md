---
name: vendo-setup
description: Install and configure Vendo (the embedded product agent) in a host repo. Use when asked to add Vendo to an app, run vendo init/doctor/sync, wire the Vendo handler or VendoRoot, or debug a Vendo install until doctor exits 0.
---

# Vendo setup

Vendo embeds an agent inside a host product: it extracts the host's API as
tools, renders generated UI in a sandboxed brand-native surface, and acts as
the signed-in user. This skill installs and verifies Vendo in a host repo.

The canonical staged playbook lives at https://docs.vendo.run/install.md —
fetch it when you need more detail than this skill carries.

## Stage 1 — base install

1. Install the umbrella package (either name; `vendoai` is a thin alias):

   ```bash
   npm install @vendoai/vendo
   ```

2. Run init. As an agent, plan first, then apply:

   ```bash
   npx vendo init --agent   # read-only JSON plan: framework, code diffs, questions, extracted tools, risk recommendations
   npx vendo init --yes --model-import "@/lib/ai" --brief "<one-paragraph product brief>"
   ```

   `--agent` writes nothing. `--yes` approves every displayed diff, so read the
   plan's `codeChanges` before running it. Without `--yes`, init interviews the
   user (four questions) and asks per-diff consent — prefer that when a human
   is present.

3. What init does (framework detected from `package.json`, `next` beats
   `express`; anything else is treated as Next):
   - Writes `.vendo/` — `tools.json` (extracted tools), `overrides.json`
     (your risk/critical edits, respected forever), `policy.json`,
     `brief.md`, `theme.json` (brand extracted from the host CSS), and a
     gitignored `.vendo/data/` for the PGlite store. Commit `.vendo/`,
     never `.vendo/data/`.
   - Next.js: proposes `app/api/vendo/[...vendo]/route.ts` (or under
     `src/app`), wraps the root layout in `<VendoRoot theme={...}>`, and
     scaffolds a starter model module when the import cannot resolve.
   - Express: proposes `vendo/server.ts` (`.mjs` without a tsconfig) plus a
     starter `vendo/ai.ts`; you must still mount
     `app.use("/api/vendo", mountVendo())` and wrap the client in
     `<VendoRoot>` yourself.
   - Adds `predev`/`prebuild` sync hooks to `package.json` (consent-gated).

4. Model credential: the starter model module uses
   `createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`. Install its
   pinned peers and set the key:

   ```bash
   npm install ai@^6 @ai-sdk/anthropic@^3
   echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env.local
   ```

   Never invent a key; ask the user for one if none is set. Any AI SDK
   provider works — point `--model-import` at the host's own model module
   when one exists.

5. Verify. Start the dev server, then:

   ```bash
   npx vendo doctor
   ```

   Doctor checks wiring plus one live `/status` round-trip against
   `http://localhost:3000/api/vendo` (override with `--url` or `VENDO_URL`).
   Exit 0 = green; exit 1 prints each `broken:` line. Fix and re-run until 0.
   Common fixes: dev server not running (start it), missing `.vendo/*` file
   (re-run `npx vendo init`), layout not wrapped (apply the skipped diff by
   re-running init and approving it).

## Stage 2 — review and keep extraction fresh

- Re-extract after API changes: `npx vendo sync` (fail-soft). In CI use
  `npx vendo sync --strict` — exit 2 on breaking tool changes, 3 when saved
  apps/automations/grants are impacted. `--json` emits one machine-readable
  report object on stdout.
- Review `.vendo/tools.json`; put corrections in `.vendo/overrides.json`
  (`{"tools": {"host_invoices_delete": {"critical": true}}}`) — never edit
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
  with `VENDO_API_KEY` (`npx vendo cloud login <email>`).

## Rules

- Show the user every proposed code diff before applying it unless they
  explicitly asked for unattended setup.
- Do not hand-edit generated files (`.vendo/tools.json`, theme regeneration);
  use `overrides.json` and re-run sync.
- Done means `npx vendo doctor` exits 0 against a running dev server, not
  merely that files exist.

# demo-template

`demo-template` is the skeleton a future demo-creator agent clones and
rewrites for each sales prospect. It ships invisible plumbing — build
tooling, lint/test config, minimal Next.js scaffolding, and the Vendo wiring
below — with no brand or product surface baked in.

Everything visible (pages, components, styling, copy, seed data) is a
placeholder the creator agent replaces. Vendo is wired minimally:

- `src/vendo/server.ts` — `createVendo` with the metered `vendoModel()`,
  anonymous per-visitor principals (no login wall), and an empty
  host-component catalog (a creator seam). See "Cloud posture" below for the
  store/connections/model slots.
- `src/vendo/theme.ts` + `.vendo/theme.json` — neutral default theme the
  creator overwrites with the prospect's brand.
- `src/server/` — ONE worked example of the fake-host-API pattern (a generic
  `items` entity: deterministic seed, in-memory store, list + archive). The
  creator replaces these example entities with prospect-domain ones —
  EXCEPT `src/server/caps.ts`, which is plumbing and stays.
- `src/server/caps.ts` + the guard wrapper in
  `src/app/api/vendo/[...vendo]/route.ts` — the caps guard enforcing
  demo.config's `caps.maxTurns` (turns = POST /api/vendo/threads),
  `caps.maxSpendUsd` (real token usage via model middleware), and
  `expiresAt`. Refusals are 429 (410 when expired) with a
  `{ vendoDemo: { limit, message, ctaUrl } }` body. Counters persist in
  `.vendo/data/demo-caps.json`; delete the file to reset a demo. Corrupt
  counters fail closed. `DEMO_CAPS_MAX_TURNS` is a runtime test knob for
  verification only. Deployed demos run on OUR key — creator agents must
  never modify the guard, the route wrapper, or the model wrapping in
  `src/vendo/server.ts`.
- `src/app/api/items/...` + `openapi.json` — the example routes, declared in
  the OpenAPI spec so `vendo sync .` (run automatically in
  `predev`/`prebuild`) exposes them as agent-callable tools in
  `.vendo/tools.json`.
- `/vendo` — the panel page: `DemoPanel` composes the demo chrome, the beat
  chips, and `VendoRoot` + `VendoThread`. The server page reads demo.config
  and the caps guard's non-consuming `peekRefusal()` so a limited/expired demo
  renders the friendly card on load.
- `src/components/demo-chrome.tsx` — PLUMBING the creator must keep: the
  "[Prospect] demo · built with Vendo · sample data" badge, the "Get this in
  your product" CTA (demo.config `ctaUrl`), and the limit/expired card. The
  mounted chrome polls `GET /demo-status` (a read-only caps check that
  never consumes a turn) so an exhausted cap swaps in the card mid-session
  instead of leaving only the thread's generic error toast.
- `src/components/suggestion-chips.tsx` — demo.config `beats` as a persistent
  chip strip (labels from `beats[].chip`). The creator's `demo:chips` stage
  derives those pills from this app's OWN `.vendo/tools.json`, so they name
  capabilities the demo can really perform; hand-authored beats win. First-turn submission goes through
  `VendoThread`'s official `suggestions` prop (the panel passes the beats'
  prompts, shown on the empty landing; clicking sends one). Mid-thread there
  is no @vendoai/ui seam to prefill/submit the composer from outside, so a
  clicked chip reveals its prompt with a copy button — see the SEAM NOTE in
  the file before "improving" this with DOM hacks.

## Cloud posture

A deployed demo runs as a Cloud tenant under ONE `VENDO_API_KEY`, pointed at
the managed "Demos" project. That single variable composes three things at
once, which is why the slots below are deliberately left UNSET:

- **Store** — unset, so the key composes the Cloud HOSTED store. A demo
  container's filesystem is ephemeral: a container-local store would silently
  wipe every demo's state on each redeploy.
- **Connections / connectors** — unset, so the key composes the Cloud broker
  (that is what makes "connect your Gmail" work on a live demo). An explicit
  `connectors: []` would read as "no connectors, ever" — the seam honors it.
  `connectorApps` scopes the auto-composed pair to `gmail`,
  `googlecalendar` and `slack`, so the connect dock never advertises the
  console's whole catalog to a prospect.
- **Model** — `vendoModel()`, whose credential ladder sends inference to the
  key's metered gateway. It stays wrapped in the spend middleware: PLUMBING,
  see below.

Local dev pins the local PGlite store with `DEMO_STORE=local` in `.env.local`,
so a laptop never shares the deployed demo's tenant (mirroring demo-bank's
`MAPLE_STORE=local`). An explicitly passed adapter always beats the key
default, per the adapter rule.

Credentials: `VENDO_API_KEY` for the Cloud posture, or `ANTHROPIC_API_KEY`
for BYO. `VENDO_DEMO_MODEL` optionally pins a model name, passed through
verbatim to whichever rung resolved.

## Setup

```bash
cd examples/demo-template
pnpm dev
```

Open http://localhost:3000. Run `pnpm test` for the test suite. Tests come in
two kinds, marked in the files: structural invariants that must keep passing
for ANY demo cloned from this template (config schema, caps guard, seed
determinism, no `TODO(creator)` leftovers), and blocks/files headed
"DELETE OR REWRITE on clone" that pin the template's sample content only — a
rewritten demo is supposed to fail exactly those until the creator rewrites
them for its domain.

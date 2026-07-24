# demo-template

`demo-template` is the skeleton a future demo-creator agent clones and
rewrites for each sales prospect. It ships invisible plumbing — build
tooling, lint/test config, minimal Next.js scaffolding, and the Vendo wiring
below — with no brand or product surface baked in.

Everything visible (pages, components, styling, copy, seed data) is a
placeholder the creator agent replaces. Vendo is wired minimally:

- `src/vendo/server.ts` — `createVendo` with an anthropic model, local
  `.vendo/data` store, anonymous per-visitor principals (no login wall), and
  an empty host-component catalog (a creator seam).
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
  chip strip (labels from `beats[].chip`). First-turn submission goes through
  `VendoThread`'s official `suggestions` prop (the panel passes the beats'
  prompts, shown on the empty landing; clicking sends one). Mid-thread there
  is no @vendoai/ui seam to prefill/submit the composer from outside, so a
  clicked chip reveals its prompt with a copy button — see the SEAM NOTE in
  the file before "improving" this with DOM hacks.

Set `ANTHROPIC_API_KEY` (and optionally `VENDO_DEMO_MODEL`) to chat.

## Setup

```bash
cd apps/demo-template
pnpm dev
```

Open http://localhost:3000. Run `pnpm test` for the test suite. Tests come in
two kinds, marked in the files: structural invariants that must keep passing
for ANY demo cloned from this template (config schema, caps guard, seed
determinism, no `TODO(creator)` leftovers), and blocks/files headed
"DELETE OR REWRITE on clone" that pin the template's sample content only — a
rewritten demo is supposed to fail exactly those until the creator rewrites
them for its domain.

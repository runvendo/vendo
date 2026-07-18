# Server-wiring DX — brainstorm outcome

Lane of the install-dx-2 coordinator. Brainstormed interactively with Yousef,
2026-07-17/18. **Status: CONVERGED — decisions below approved by Yousef.**

## Goal

Collapse the server-side integration surface to the smallest honest form. Today
a host writes ~270 lines across four wiring files plus two route files, imports
from five module paths, expresses the same identity three ways, hand-duplicates
one schema per catalog component, and can silently lose credential forwarding
via an unset env var. Target: one file the host owns, two lines of meaningful
config, one import path.

## The converged shape

A host's entire server wiring is one `vendo/server.ts` calling `createVendo`
with two keys: `model` (any AI SDK provider instance) and `auth` (one preset).
The init-generated catch-all route is untouched and never edited. Everything
else in the config bag is optional with working defaults, added one line at a
time as needs grow.

## Decisions (with Yousef)

1. **`auth` becomes a first-class config key** replacing the trio
   `principal` + `actAs` + `oauth`. One preset per auth system (Auth.js,
   Clerk, Supabase, Auth0, generic JWT) fills all three seams from one config.
   Presets are zero-argument in the standard case: they read their own env
   (e.g. AUTH_SECRET, mirroring Auth.js itself) and derive display/email from
   session-token claims; a subject→user resolver is optional for custom logic.
   The three underlying seams survive as the escape hatch for hosts without a
   preset. *Contract-amending* (config-bag shape; v2 unfreeze covers it).
   Rationale: demo-bank derives all three seams from the same two lookups —
   ~115 lines of glue for one identity story.

2. **The `catalog` key leaves `createVendo` entirely.** Component registration
   moves client-side, next to the components map the host already maintains —
   the pattern Tambo and CopilotKit use (one registration object: component
   reference, description, one optional zod schema; the framework serializes
   it to the model side). Kills the dual zod + hand-written JSON Schema
   registration (~30 drift-prone lines/component). The server persists the
   last-seen catalog in the store so away automations and MCP-door generation
   work with no browser open. Client-side details belong to the client-lane;
   this lane's decision is only that the server config sheds the key.
   *Contract-amending.*

3. **`model` stays exactly an AI SDK provider instance.** No string forms, no
   resolution ladder in `createVendo`. The dev-credential ladder (CLI
   sessions, cloud starter key) is `vendo init`'s business: init scaffolds
   `lib/ai.ts` with `devModel()`, and the host deletes that line whenever they
   paste a real provider. Keys are env-first with inline overrides through the
   provider's own options (the AI SDK's layer, not ours); no secrets ever live
   in the config bag.

4. **`mcp` keeps its one-flag shape but is unblessed until proven.** With
   unified `auth`, the separate `oauth` requirement dies and `mcp: true` is
   genuinely one boolean. But the door stays out of the quickstart/docs main
   path until the live client matrix (real Claude, ChatGPT, Cursor
   connections) is green — protocol-level e2e coverage exists
   (fixtures/mcp-e2e), the attended live leg has not been demonstrably run.
   The `.well-known` route file becomes a re-export of a shipped handler so
   the four-path allowlist lives in the package and cannot drift.
   *Contract-compatible.*

5. **The `VENDO_BASE_URL` trap is defanged.** Dev auto-trusts its own origin;
   production without the var fails loud (doctor/startup) instead of silently
   dropping credential forwarding on present-mode tool calls.
   *Contract-compatible.*

6. **Bare `createVendo()` legitimately boots** (anonymous sessions, PGlite
   store) — every config key optional; `model` + `auth` is the real
   quickstart rung.

7. **Connectors: enabling everything is the default.** A bare `composio()`
   exposes the full Composio catalog; `apps:` narrows. Safe because the agent
   already runs a bounded initial tool loadout with search-based discovery,
   per-user account connection is consent-gated, and every call passes the
   guard.

8. **Policy gains named presets** — `"cautious"` (writes ask, reads run),
   `"readonly"`, `"autopilot"` — as shorthand values alongside the existing
   file and inline-rules forms. Answers "what goes in policy.json" on day one.

9. **Import consolidation:** everything a host wires comes from
   `@vendoai/vendo/server` plus their chosen AI SDK provider package.

## Research grounding

Surveyed comparable devtools (2026-07-17): Tambo and CopilotKit register
generative-UI components client-side with a single zod schema — nobody does
build-time type extraction (an earlier direction we explicitly rejected as
over-engineered). uploadthing sets the route-wiring bar (one router file, a
one-line route re-export). Liveblocks does auth as one explicit endpoint with
the host's own session lookup — explicit-with-presets over silent detection.
Vercel's mcp-handler has the identical `.well-known` problem and ships the
handler rather than hiding the file.

## Open questions (for the coordinator)

- **Express**: init leaves two manual steps; Yousef didn't engage on whether
  Express polish is in scope this round. Unresolved.
- **Migration**: the auth-key and catalog changes break existing hosts'
  config shape; a migration story (docs vs codemod) was deliberately left out
  of this lane's scope.
- **Door graduation criteria**: who runs the attended live matrix
  (Claude/ChatGPT/Cursor) that unblocks blessing `mcp` in the quickstart.
- **Server-persisted catalog semantics** (staleness, trust) land with the
  client-lane's registration design.

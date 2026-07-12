# Umbrella hookup for @vendoai/mcp — follow-up for the composition worktree

Status: HANDOFF NOTE. The door (`@vendoai/mcp`) shipped in its own PR without
the umbrella wiring, because `packages/vendo` (the composition worktree) was not
on `main` when wave 6 landed (10-mcp LAST STEP: the one-boolean hookup belongs
to composition's package, and this worktree must not edit `packages/vendo` while
composition is unmerged). When both are on `main`, wire the door in as follows.

## The one flag (10-mcp §1)

`createVendo({ mcp: true })` — an additive boolean, allowed within the version
train. The boolean is the whole one-flag story; the door also needs the host's
identity seam, which the umbrella threads through like `actAs`:

```ts
createVendo({
  mcp: true,
  oauth: HostOAuthAdapter,   // §3 two-function seam — REQUIRED when mcp is true;
                             // the door cannot mint principals without it
})
```

Decide with Yousef whether `oauth` is a top-level config key or nested under an
`mcp` object (`mcp: { oauth }`). The door itself is agnostic.

## Wiring (all inside packages/vendo)

1. **Manifest + dep guard**: add `"@vendoai/mcp": "workspace:*"` to
   `packages/vendo`'s dependencies. `@vendoai/mcp` is already in the
   dependency-guard layer map (core-only); the umbrella (`vendoai`) is already
   allowed to depend on everything, so no guard edit is needed beyond the
   manifest.

2. **Construct the door** when `config.mcp` is true, from parts the umbrella
   already has assembled:

   ```ts
   import { createMcpDoor } from "@vendoai/mcp";

   const door = createMcpDoor({
     tools: boundRegistry,   // the SAME guard-bound registry chat/apps/automations use
     guard,                  // the VendoGuard (its core Guard seam is what the door holds)
     store,
     oauth: config.oauth,
     apps: appsPortAdapter,  // see step 3
   });
   ```

3. **AppsPort adapter**: `AppsRuntime.open` returns an extra `"resuming"`
   variant, so `vendo.apps` is not directly assignable to `AppsPort` (which is
   `tree | http` only). Wrap it — the shape is in
   `fixtures/mcp-e2e/src/harness.ts` (search `AppsPort`), ~5 lines: pass
   `list`/`call` through; map `open`'s `resuming` to a cover/http or treat it as
   unreachable for the door's viewer role.

4. **Mount the handler on the wire routes** (09 §3). The door derives its mount
   path from the request URL, and it serves discovery documents at the ORIGIN
   ROOT, so it must see three path families, all routed to `door.handler`:
   - the door path itself (e.g. `/api/vendo/mcp`, POST/GET/DELETE)
   - `/.well-known/oauth-protected-resource/*` and
     `/.well-known/oauth-authorization-server/*`
   - `/.well-known/mcp/server-card.json` and `/.well-known/mcp-server-card`

   In a Next.js host these are catch-all routes; the umbrella's route glue
   already owns the `/api/vendo/*` surface — extend it to forward the
   well-known prefixes too.

5. **Default policy posture** (10-mcp §2): the shipped policy example (05 §3)
   BLOCKS `venue: "mcp"`. `vendo init` must ask before opening the door —
   opening it is a host decision, never a default. Wire that prompt into the
   init flow.

6. **`vendo doctor`** (10-mcp §5): add a check that both metadata documents
   resolve and the server card parses.

## E2E for the hookup

`fixtures/mcp-e2e/` already composes exactly this by hand (real store + guard +
actions + apps + door on a real loopback origin). Port it to the umbrella's own
e2e as a single `createVendo({ mcp: true })` test: assert the mounted handler
answers the 401→discovery→OAuth→initialize→tools/call round trip through the
real MCP SDK client. The env-gated live leg (`VENDO_LIVE_MCP=1`) can move too.

## Verified in this PR (so the hookup only needs wiring, not re-proving)

The door itself is fully tested against the real MCP SDK client and live Claude
Code; the umbrella work is pure composition. See PR #122.

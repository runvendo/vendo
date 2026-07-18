# Server-wiring DX → init-lane handoff

From the server-wiring DX lane (docs/superpowers/plans/2026-07-18-server-wiring-dx.md,
Wave 4) to whichever lane next touches `vendo init`. Wave 4 deliberately never
touched `packages/vendo/src/cli/init.ts` or any scaffold template — this note
is the handoff instead. Read docs/brainstorms/server-wiring-dx.md for the
full design; this note is the scaffold-facing summary plus known gaps.

## What init currently scaffolds (stale)

`packages/vendo/src/cli/init.ts` (`nextServerSource` around line 149,
`expressServerSource` around line 218) still writes:

```ts
const vendo = createVendo({
  model,
  principal: async () => null,
});
```

No `auth`, no `catalog`, no registry file. This was correct before this lane
and is now the old surface — every demo and the docs have moved past it.

## What init should scaffold once it adopts the new surface

1. **`vendo/registry.tsx`** — empty to start:

   ```tsx
   import type { ComponentRegistry } from "@vendoai/core";

   export const registry = {} satisfies ComponentRegistry;
   ```

   A host adds entries as `{ component, description, props?, examples? }` keyed
   by name (`packages/core/src/catalog.ts` — `ComponentRegistryEntry`). Real
   examples in `apps/demo-bank/src/vendo/registry.tsx` (post wave-3/4) and
   `apps/demo-accounting/src/vendo/registry.tsx` (migrated this wave).

2. **`vendo/server.ts`** — `model` + an `auth` preset + the registry as
   `catalog`:

   ```ts
   import { authJs, createVendo } from "@vendoai/vendo/server";
   import { registry } from "./registry";

   export const vendo = createVendo({
     model,
     auth: authJs(),
     catalog: registry,
   });
   ```

   Detect which preset to write from the host's `package.json` dependencies —
   `next-auth`/`@auth/core` → `authJs()`, `@clerk/nextjs` → `clerk()`,
   `@supabase/*` → `supabase()`, `@auth0/nextjs-auth0` → `auth0()`; no match →
   either omit `auth` entirely (bare `createVendo({ model })` boots fine,
   anonymous sessions only) or scaffold the `jwt({ secret })` prompt, since
   `jwt()` is the one non-zero-arg preset. Presets live at
   `packages/vendo/src/auth-presets/*.ts`, re-exported from
   `@vendoai/vendo/server`; the full option shape (including the `secret` and
   `user` overrides) is in `docs/act-as-presets.md`.

3. **`<VendoRoot>` wiring** — pass the same registry object as `components`:

   ```tsx
   import { VendoRoot } from "@vendoai/vendo/react";
   import { registry } from "@/vendo/registry";

   <VendoRoot components={registry}>{children}</VendoRoot>
   ```

   `components` accepts either the registry or a plain `Record<string,
   ComponentType>` (`packages/ui/src/context.tsx` — `HostComponentsInput`), so
   this is additive, not breaking, if init needs a transition period.

4. **`.well-known/[...vendo]/route.ts`** — a two-line re-export of the shipped
   handler, not a hand-copied allowlist:

   ```ts
   import { wellKnownVendoHandler } from "@vendoai/vendo/server";
   import { vendo } from "@/lib/vendo"; // or "@/vendo/server"

   export const { GET, POST } = wellKnownVendoHandler(vendo);
   ```

   **`init.ts`'s `wellKnownRouteSource()` (around line 202) currently
   hand-writes the same four-path `DOOR_PATHS` allowlist** that this lane just
   deleted from `apps/demo-bank`'s and would have deleted from
   `apps/demo-accounting`'s well-known route (demo-accounting never had one).
   That hand-written copy is now the ONLY allowlist left in the repo outside
   the package itself — it can drift from `packages/vendo/src/server.ts`'s
   `DOOR_WELL_KNOWN_PATHS` the same way the demo routes used to. Swap it for
   the `wellKnownVendoHandler` re-export above; delete `wellKnownRouteSource()`
   once nothing calls it.

## Known gaps for the init lane to be aware of

- **`supabase()` preset can't verify ES256 sessions.** The shipped preset
  (`packages/vendo/src/auth-presets/supabase.ts`) verifies only HS256 sessions
  against the project's legacy JWT secret. Supabase projects using JWT signing
  keys (`supabase start` >= v2.71) issue ES256-signed login sessions verified
  through GoTrue's JWKS — the preset has no JWKS support. `apps/demo-accounting`
  hits this for real (see its `src/server/session.ts` hybrid HS256+JWKS
  verifier) and was deliberately NOT migrated to `auth: supabase()` this wave;
  its `vendo/server.ts` keeps the hand-wired `principal`/`actAs` trio with a
  comment citing this gap. If init auto-detects `@supabase/*` and offers
  `auth: supabase()`, it should say out loud that this only covers the legacy
  HS256 JWT-secret project setting, not the newer JWKS-signed one.
- **`@vendoai/actions`' `authJsPreset`'s dynamic `@auth/core/jwt` import
  caches a rejection permanently.** `packages/actions/src/presets/auth-js.ts`
  line ~42-46:

  ```ts
  let encodePromise: Promise<AuthJsEncode> | undefined;
  const loadEncode = (): Promise<AuthJsEncode> => {
    encodePromise ??= import("@auth/core/jwt").then(...);
    return encodePromise;
  };
  ```

  `??=` only reassigns when `encodePromise` is `undefined`; once the import
  rejects (e.g. `@auth/core` briefly missing during install, a transient
  resolution error), `encodePromise` holds a rejected promise forever and
  every subsequent `authJsPreset()`/`authJs()` away/MCP call fails, even after
  the module becomes resolvable. One-line fix: clear `encodePromise` back to
  `undefined` in a `.catch()` before rethrowing, so the next call retries.
  Not fixed in this lane (out of scope for docs/demos); flagging since init
  scaffolds `authJs()` as the default preset and a host could hit this on a
  flaky first install.
- **`apps/demo-bank/src/vendo/mcp-config.test.ts` has pre-existing tsc
  errors**, unrelated to this lane: `mapleMcpConfig({})` and friends pass a
  partial object where `NodeJS.ProcessEnv` requires `NODE_ENV`
  (`error TS2345: Property 'NODE_ENV' is missing in type '{}' ...`), three
  call sites. Verified present on this branch before and after Wave 4's
  changes — vitest passes, only `tsc --noEmit` on demo-bank flags it. Leave
  for whichever lane next touches that file's env-shaped test fixtures.

## Where the new surface is documented

- `docs/quickstart.md` — the two-file shape (`vendo/registry.tsx` +
  `vendo/server.ts`), the real `CreateVendoConfig`, and the (now loud-fail)
  `VENDO_BASE_URL` semantics.
- `docs/act-as-presets.md` — the `auth` preset catalog and the per-seam
  escape hatch.
- `docs-site/capabilities/mcp.mdx` — the MCP door, marked experimental with
  the live-client-matrix graduation criterion, including the
  `wellKnownVendoHandler` re-export this note asks init to adopt.
- `apps/demo-bank/src/vendo/{registry.tsx,server.ts}` and
  `apps/demo-accounting/src/vendo/{registry.tsx,server.ts}` — real migrated
  examples, one with `auth: authJs()`, one deliberately still on the hand-wired
  trio (the Supabase gap above).

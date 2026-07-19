# Server-wiring DX → init-lane handoff

From the server-wiring DX lane (docs/superpowers/plans/2026-07-18-server-wiring-dx.md,
Wave 4) to whichever lane next touches `vendo init`. Wave 4 deliberately never
touched `packages/vendo/src/cli/init.ts` or any scaffold template — this note
is the handoff instead. Read docs/brainstorms/server-wiring-dx.md for the
full design; this note is the scaffold-facing summary plus known gaps.

> **Status 2026-07-18: CLOSED.** Adopted by the init-scaffold lane
> (branch `yousefh409/init-scaffolds-two-file-surface`). Every item below
> carries its own dated closure line; the one remaining OPEN item is the
> pre-existing demo-bank `mcp-config.test.ts` tsc errors, re-verified still
> present and still out of scope here.

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

   **CLOSED 2026-07-18** — init scaffolds `vendo/registry.tsx` (mirroring the
   app dir: `src/app` → `src/vendo`; Express: `vendo/registry.tsx`/`.mjs`),
   empty with the one-file/two-consumers doc-comment and a commented
   SpendingDonut example. Generated only while absent — never clobbered, and
   never orphaned next to a hand-wired route that ignores it.

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

   **CLOSED 2026-07-18, with one deliberate deviation** — the composition
   stays INLINE in the generated catch-all route rather than splitting into a
   separate `vendo/server.ts`: the route is init's one recognized createVendo
   shape (the ENG-248 serverActions rewiring depends on it), and a split
   would add a third generated file for no behavior. The route now carries
   `catalog: registry` plus detect+confirm auth wiring from package.json
   dependencies (Yousef's revision over the original silent-detection ask):
   one unambiguous family → ONE consent-style [Y/n] confirm in interactive
   runs (Enter accepts; decline stays anonymous with the exact line named),
   accepted silently under `--yes`/non-interactive/--agent; none or several
   → anonymous plus ONE advisory line naming the exact line to add. `jwt()`
   is advice-only, never scaffolded; the wired preset line carries an
   escape-hatch comment.

3. **`<VendoRoot>` wiring** — pass the same registry object as `components`:

   ```tsx
   import { VendoRoot } from "@vendoai/vendo/react";
   import { registry } from "@/vendo/registry";

   <VendoRoot components={registry}>{children}</VendoRoot>
   ```

   `components` accepts either the registry or a plain `Record<string,
   ComponentType>` (`packages/ui/src/context.tsx` — `HostComponentsInput`), so
   this is additive, not breaking, if init needs a transition period.

   **CLOSED 2026-07-18** — the printed paste block gains
   `import { registry } from "../vendo/registry";` and the wrap becomes
   `<VendoRoot components={registry} …>` (still one pasted line plus its
   imports; omitted honestly when no registry file exists or is planned).

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

   **CLOSED 2026-07-18 (was already done)** — this bullet was stale when
   written: `wellKnownRouteSource()` was added in c2bd4c37 and deleted by the
   zero-question init rewrite (f2c23568), before this handoff landed. Current
   init generates no well-known route at all (it does not enable `mcp:`), so
   no hand-copied allowlist exists outside the package; a host that turns on
   the door adds the two-line `wellKnownVendoHandler` re-export per
   `docs-site/capabilities/mcp.mdx`.

## Known gaps for the init lane to be aware of

- **`supabase()` preset verifies sessions hybrid (CLOSED 2026-07-18 by
  PR #379 — was: HS256-only).**
  The shipped preset (`packages/vendo/src/auth-presets/supabase.ts`) now
  verifies HS256 sessions offline against the project's legacy JWT secret AND
  ES256 login sessions (`supabase start` >= v2.71, hosted projects on JWT
  signing keys) against GoTrue's JWKS (SUPABASE_URL-derived, `jwks` option
  override, lazy jose). `apps/demo-accounting` is migrated to
  `auth: supabase()` (`cadenceAuth` in its `src/vendo/auth.ts`); its own
  `src/server/session.ts` keeps the same hybrid for non-vendo routes. Init can
  offer `auth: supabase()` for both project key setups.
- **`@vendoai/actions`' `authJsPreset`'s dynamic `@auth/core/jwt` import
  caches a rejection permanently. (CLOSED 2026-07-18 by PR #378 —
  `loadEncode` now clears `encodePromise` in the rejection handler so the
  next call retries after an install; same pattern applied in the umbrella
  preset's `loadGetToken`.)** `packages/actions/src/presets/auth-js.ts`
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
  (Re-verified STILL OPEN 2026-07-18 by the init-scaffold lane — three
  `error TS2345` sites remain; deliberately not closed here.)

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

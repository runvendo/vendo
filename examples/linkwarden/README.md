# Linkwarden — Vendo on a real open-source product

The runnable example lives in its own repository:
**[runvendo/linkwarden-vendo](https://github.com/runvendo/linkwarden-vendo)** —
a fork of [Linkwarden](https://github.com/linkwarden/linkwarden) (a bookmark
manager: Next.js Pages Router, next-auth v4, Prisma/Postgres, yarn workspaces)
with a Vendo agent embedded the way you'd embed it in your own product.

It lives outside this repo on purpose: Linkwarden is AGPL-3.0 and this repo is
Apache-2.0, so the fork carries the *applied* integration under upstream's
license, while this page carries the **canonical, copyable snippets** under
this repo's. Walkthrough: the
[integration guide](https://docs.vendo.run/vendo-agent/linkwarden) on the docs
site.

What it demonstrates that the in-repo demo hosts don't:

- **A product Vendo didn't write.** Real routes, real auth, real workspace
  quirks — every snippet below earned its place by fixing a wall we hit.
- **The BYO-identity recipe** for a session scheme the presets don't speak
  (next-auth v4).
- **A workspace with a conflicting `ai` major** (worker on ai@5, Vendo needs
  ai@6) and the resolution fix.

## The whole integration

Four touches on upstream files, plus new files (`vendo init` writes the
`.vendo/` contract and route scaffold; the rest is shown here in full).

### 1. The server wire, with a host-resolved principal

`apps/web/app/api/vendo/[...vendo]/route.ts` — an App Router route beside the
Pages Router app. Linkwarden speaks next-auth v4, which the stock `authJs()`
preset (Auth.js v5) cannot read — and Vendo mints no anonymous identities, so
an unreadable session is a hard 403. The host resolves its own session and
hands Vendo a principal; v4's own `getToken` decodes the session JWE with
`NEXTAUTH_SECRET`:

```ts
import { getToken } from "next-auth/jwt";
import { createVendo, guard, nextVendoHandler } from "@vendoai/vendo/server";
import { registry } from "../../../../vendo/registry";

const vendo = createVendo({
  auth: {
    principal: async (request: Request) => {
      const token = await getToken({ req: request as never });
      if (token?.sub === undefined || token.sub === null) return null;
      return { kind: "user" as const, subject: `user_${token.sub}` };
    },
  },
  components: registry,
  guard: guard({ policy: {} }), // .vendo/policy.json: destructive asks, reads run
});

export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);
```

On Auth.js v5, Clerk, Supabase, or Auth0 you skip all of this — `auth:
authJs()` and friends are one line ([Auth](https://docs.vendo.run/deploy/auth)).

### 2. The client mount

`apps/web/pages/_app.tsx` — wrap the app, add the overlay. One subtlety this
workspace surfaces: import provider and overlay from **one package specifier**.
In a workspace where the umbrella resolves its own nested `@vendoai/ui` copy,
mixing `@vendoai/vendo/react` imports with direct `@vendoai/ui` imports on the
same page yields two React contexts that cannot see each other:

```tsx
import { VendoProvider } from "@vendoai/ui";
import { VendoOverlay } from "@vendoai/ui/chrome";

<VendoProvider baseUrl="/api/vendo">
  {getLayout(<Component {...pageProps} />)}
  <VendoOverlay />
</VendoProvider>
```

(Single-app repos: `import { VendoOverlay, VendoProvider } from
"@vendoai/vendo/react"` is the normal form.)

### 3. Config

`apps/web/next.config.js`:

```js
serverExternalPackages: ["@vendoai/apps", "esbuild", "@electric-sql/pglite", "@vendoai/store"],
```

`@vendoai/apps` is the load-bearing entry: it reaches esbuild through a variable
specifier the bundler cannot see, so an `"esbuild"` entry on its own is inert
(`vendo doctor` fails `E-CFG-004` without the package).

### 4. The conflicting-`ai`-major fix

Root `.yarnrc.yml` — the worker holds `ai@5` at the workspace root; `@vendoai/*`
needs `ai@6`. Give `@vendoai/vendo` its own nested copy (`vendo doctor` names
this fix as E-DEP-001):

```yaml
packageExtensions:
  "@vendoai/vendo@*":
    dependencies:
      ai: "^6.0.230"
      "@auth/core": "^0.41.3"
```

### Env

`VENDO_API_KEY` (run `npx vendo login` from `apps/web` — the key lands in that
directory's `.env.local`) and `VENDO_BASE_URL` (the deployment's full public
URL; machine provisioning fails without it).

## Run it

Quickstart, known issues, and the AGPL notice of changes:
[runvendo/linkwarden-vendo](https://github.com/runvendo/linkwarden-vendo).

<!-- No package.json here on purpose: this directory documents; the fork runs.
     Adding a manifest would pull an AGPL yarn workspace into this pnpm
     workspace, its dep tree into the audit gate, and next-auth v4 under the
     root's v5 security floor. -->

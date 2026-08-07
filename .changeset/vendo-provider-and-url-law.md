---
"@vendoai/core": minor
"@vendoai/actions": minor
"@vendoai/ui": minor
"@vendoai/mcp": patch
"@vendoai/vendo": minor
"vendoai": minor
---

The setup surface: declared URLs, one join law, a VendoProvider-only surface, and `init` = install + the shared sync flow.

**Breaking: `VendoRoot` is removed. Use `VendoProvider`.**

```diff
-import { VendoRoot } from "@vendoai/vendo/react";
-<VendoRoot components={registry}>{children}</VendoRoot>
+import { VendoProvider } from "@vendoai/vendo/react";
+<VendoProvider baseUrl="/api/vendo" components={registry}>{children}</VendoProvider>
```

That is the whole migration: the props are identical, and `baseUrl` is the wire
mount with your deployment's path prefix included (default `/api/vendo`).
`npx vendo doctor` names the swap and the file if you miss one (`E-WIRE-010`).

**Breaking: `VENDO_BASE_URL` is the app's FULL public URL, path prefix included.**

Set it to `https://site.com/maple`, not `https://site.com`. Nothing strips its path
any more: host tool calls, login redirects and box callbacks all hang off it, each
attaching the prefix exactly once through one helper in `@vendoai/core`. Two new
optional overrides: `VENDO_HOST_API_URL` (the host API on another origin) and
`VENDO_LOGIN_URL` (the login page, which may be on another domain).

Stored tool paths in `.vendo/tools.json` are now **prefix-free** — run `vendo sync`
once to regenerate them. This closes #866 (login redirect drops the base path),
#867 (returnTo double-prefix) and #914 (host tools 404 under a path prefix). When the
client and the server disagree about where the wire is mounted, the browser now gets
one loud named error instead of a mysterious 404, and `vendo doctor` catches an
OpenAPI server mount that disagrees with `VENDO_BASE_URL` (`E-CFG-003`).

**`vendo init` no longer generates `vendo/registry.tsx` or `vendo/vendo-root.tsx`.**

It scaffolds the server route handler and prints one paste: `<VendoProvider>` around
your client root. If you have host components, you write one small `"use client"`
file yourself — see the quickstart. Existing generated files are untouched; they are
yours now.

**`vendo init` ends in the same flow `vendo sync` runs.** One extraction, one theme
path, one consent question, one report — `init` in full mode (a fresh install has
judged nothing), `sync` incremental. `init` now reads `.env` as well as `.env.local`,
so a model key that lives in `.env` is no longer invisible.

/**
 * `vendo/react` — the public React surface: the batteries-included
 * `VendoRoot` client (`@vendoai/client`), the lower-level provider/hooks
 * (`@vendoai/react`), and the embedded shell surfaces (`@vendoai/shell`).
 *
 * Browser-only: do not import this from Node server code — use
 * `vendo/server` there instead.
 *
 * Collision note: `@vendoai/shell` and `@vendoai/client` both declare a
 * `RunQuery` type (shell's is the seam contract in `seams/query.ts`;
 * client's is its own re-export of the same shape from `run-query.ts`).
 * `export *` would silently drop one of them, so it's re-exported here
 * explicitly, choosing the batteries-included `@vendoai/client` version —
 * that's the one host apps using `VendoRoot` actually see in their prop
 * types. An explicit named re-export after the `export *` wildcards
 * resolves the ambiguity in TypeScript (the explicit export wins over the
 * wildcard-induced conflict); verified with `tsc --noEmit` producing no
 * TS2308 "ambiguous export" diagnostic.
 */
export * from "@vendoai/client";
export * from "@vendoai/react";
export * from "@vendoai/shell";
export type { RunQuery } from "@vendoai/client";

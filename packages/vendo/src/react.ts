/**
 * `vendoai/react` — the public React surface: the batteries-included
 * `VendoRoot` client (`@vendoai/client`), the lower-level provider/hooks
 * (`@vendoai/react`), and the embedded shell surfaces (`@vendoai/shell`).
 *
 * Browser-only: do not import this from Node server code — use
 * `vendoai/server` there instead.
 */
export * from "@vendoai/client";
export * from "@vendoai/react";
export * from "@vendoai/shell";

/**
 * `@vendoai/next/client` is now a thin re-export of `@vendoai/client`, which
 * owns the browser half of Vendo (VendoRoot, the sandbox stage mount,
 * connect flow, and the voice driver). Kept here so existing imports from
 * `@vendoai/next/client` keep working until this package is removed.
 */
export * from "@vendoai/client";

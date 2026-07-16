import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // @electric-sql/pglite ships a WASM Postgres build whose Emscripten glue
  // code relies on being loaded as a real Node module (native require +
  // on-disk .wasm/.data assets). Turbopack's production server bundle
  // rewrites that glue and drops the `instantiateWasm` hook it needs,
  // which only surfaces once pglite runs a *fresh* WASM initdb (i.e. no
  // pre-existing data dir) — exactly the state of a first-boot deploy.
  // Marking it (and the @vendoai/store package that wraps it) external
  // keeps them as plain requires instead of bundling them.
  serverExternalPackages: ["@electric-sql/pglite", "@vendoai/store"],
};

export default nextConfig;

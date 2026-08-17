import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/wasm server deps stay out of the bundle: Mastra's storage drivers
  // (libsql, duckdb) and Vendo's defaults (PGlite's Emscripten module breaks
  // under production chunking). @vendoai/apps is the load-bearing Vendo entry —
  // it syntax-checks generated islands through a VARIABLE esbuild specifier the
  // bundler cannot see, so an "esbuild" entry alone is inert and this only ever
  // worked because the monorepo root hoists esbuild.
  serverExternalPackages: [
    "@duckdb/node-api",
    "@electric-sql/pglite",
    "@libsql/client",
    "@vendoai/apps",
    "esbuild",
  ],
};

export default nextConfig;

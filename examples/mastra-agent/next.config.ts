import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/wasm server deps stay out of the bundle: Mastra's storage drivers
  // (libsql, duckdb) and Vendo's defaults (esbuild syntax-checks generated
  // islands; PGlite's Emscripten module breaks under production chunking).
  serverExternalPackages: [
    "@duckdb/node-api",
    "@electric-sql/pglite",
    "@libsql/client",
    "esbuild",
  ],
};

export default nextConfig;

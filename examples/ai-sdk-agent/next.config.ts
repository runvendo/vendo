import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // --- vendo (1 line): keep PGlite (persistence) and esbuild (app generation's
  // syntax check) out of the bundler — both are native/wasm modules.
  serverExternalPackages: ["esbuild", "@electric-sql/pglite"],
  // --- /vendo
};

export default nextConfig;

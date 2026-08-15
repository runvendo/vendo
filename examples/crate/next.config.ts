import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Required, not optional. Vendo's composed default store is PGlite, whose
  // Emscripten module breaks under Turbopack's PRODUCTION chunking — every
  // request to the wire then 501s with "f.instantiateWasm is not a function".
  // `next dev` is fine, so the failure only appears once you build. esbuild is
  // a native binary and stays out for the same reason.
  serverExternalPackages: ["esbuild", "@electric-sql/pglite", "@vendoai/store"],
  transpilePackages: ["@vendoai/ui"],
};

export default nextConfig;

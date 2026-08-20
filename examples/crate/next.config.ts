import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Required, not optional. Vendo's composed default store is PGlite, whose
  // Emscripten module breaks under Turbopack's PRODUCTION chunking — every
  // request to the wire then 501s with "f.instantiateWasm is not a function".
  // `next dev` is fine, so the failure only appears once you build. esbuild is
  // a native binary and stays out for the same reason.
  //
  // @vendoai/apps is the entry that actually carries the esbuild one: the
  // generated-screen checker imports esbuild through a variable specifier the
  // bundler cannot follow, so bundling @vendoai/apps makes that import resolve
  // from the app root — where pnpm never hoists esbuild. Every generated screen
  // then fails its checks while the rest of the app looks perfectly healthy.
  serverExternalPackages: ["@vendoai/apps", "esbuild", "@electric-sql/pglite", "@vendoai/store"],
  transpilePackages: ["@vendoai/ui"],
};

export default nextConfig;

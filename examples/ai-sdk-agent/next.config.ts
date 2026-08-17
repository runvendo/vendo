import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // --- vendo (1 line): keep @vendoai/apps, esbuild (app generation's syntax
  // check) and PGlite (persistence) out of the bundler. @vendoai/apps is the
  // load-bearing entry — it reaches esbuild through a variable specifier the
  // bundler cannot see, so an "esbuild" entry alone is inert and this only ever
  // worked because the monorepo root hoists esbuild.
  serverExternalPackages: ["@vendoai/apps", "esbuild", "@electric-sql/pglite"],
  // --- /vendo
};

export default nextConfig;

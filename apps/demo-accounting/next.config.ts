import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // The apps engine syntax-checks generated islands with esbuild (native
  // binary) — keep it out of the Turbopack server bundle.
  serverExternalPackages: ["esbuild"],
  // Test boots (away-drill e2e) get their own dist dir → own dev-server lock,
  // so they never fight a concurrent `pnpm dev`. Nested under .next so
  // gitignore/scanner rules that skip .next cover it.
  ...(process.env.CADENCE_DIST_DIR ? { distDir: process.env.CADENCE_DIST_DIR } : {}),
};

export default nextConfig;

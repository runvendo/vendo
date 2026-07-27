import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // The apps engine syntax-checks generated islands with esbuild (native
  // binary) — keep it out of the Turbopack server bundle (demo-bank pattern).
  serverExternalPackages: ["esbuild"],
};

export default nextConfig;

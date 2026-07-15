import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Dev-only: allow the local TLS front (e.g. https://127.0.0.1:8443 for
  // broker-fronted MCP verification) to load dev resources; without this,
  // Next blocks cross-origin dev assets and pages served through the front
  // never hydrate. No effect on production builds.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;

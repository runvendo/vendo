const nextConfig = {
  // Next allows one dev server per dist dir. Concurrent consumers (the actions
  // fixture e2e and the automations e2e harness run in parallel under turbo)
  // each point FIXTURE_DIST_DIR at their own directory to get their own lock.
  distDir: process.env.FIXTURE_DIST_DIR || ".next",
};

export default nextConfig;

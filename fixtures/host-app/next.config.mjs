const nextConfig = {
  // Next allows one dev server per dist dir. Concurrent consumers (the actions
  // fixture e2e and the automations e2e harness run in parallel under turbo)
  // each point FIXTURE_DIST_DIR at their own directory to get their own lock.
  //
  // The default is a SIBLING of those, never their parent. `next build` wipes
  // its own distDir before writing, so a default of ".next" deleted
  // ".next/automations-e2e" and friends out from under four running dev
  // servers — every request after that returned 500, and because
  // `@vendoai-fixtures/host-app#build` is not a dependency of the e2e packages
  // turbo runs it right alongside them. That took out all 36
  // automations-e2e tests on every full-suite run while each suite passed
  // alone.
  distDir: process.env.FIXTURE_DIST_DIR || ".next/app",
};

export default nextConfig;

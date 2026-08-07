import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts", "src/**/*.test.ts"],
    // Journeys pack the workspace once and boot real Next dev servers on fixed
    // ports: parallel files would race the pack cache and the ports.
    fileParallelism: false,
    // A journey is scaffold → npm install → vendo init → boot → live turn;
    // installs and first compiles dominate.
    testTimeout: 20 * 60 * 1000,
    hookTimeout: 20 * 60 * 1000,
  },
});

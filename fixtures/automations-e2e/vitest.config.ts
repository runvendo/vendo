import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts", "src/**/*.test.ts"],
    globalSetup: ["./src/global-setup.ts"],
    // One shared fixture server + suites that reset its seed data: parallel
    // files would race each other's resets.
    fileParallelism: false,
    // The suites boot a real Next.js fixture server and a real (PGlite) store;
    // give slow first-compiles room.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});

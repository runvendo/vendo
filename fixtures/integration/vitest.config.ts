import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts", "src/**/*.test.ts"],
    globalSetup: ["./src/global-setup.ts"],
    // One shared fixture host-app server + suites that reset its seed data:
    // parallel files would race each other's resets. Also: each stack boots the
    // real composed umbrella and reads `.vendo/` files from cwd — serial keeps
    // that deterministic.
    fileParallelism: false,
    // The suites boot a real Next.js fixture server and a real (PGlite) store,
    // and drive real generation turns; give slow first-compiles room.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});

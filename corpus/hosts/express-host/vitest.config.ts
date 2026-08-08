import { defineConfig } from "vitest/config";
import { workerCaps } from "../../../vitest.shared.js";

export default defineConfig({
  test: {
    ...workerCaps,
    include: ["e2e/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

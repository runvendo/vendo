import { defineConfig } from "vitest/config";

// Server-side tests only — the CRA frontend is a vendored demo prop and is
// verified live in a browser instead.
export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.test.ts"],
  },
});

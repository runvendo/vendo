import { expect, it } from "vitest";
import * as mainEntry from "./index.js";
import * as postgresEntry from "./postgres.js";

// Separate file from postgres-entry.test.ts on purpose: importing the main
// entry legitimately loads PGlite, which that file's tripwire mock forbids.
it("./postgres mirrors the main entry's engine-agnostic surface", () => {
  for (const name of Object.keys(mainEntry)) {
    expect(postgresEntry, `main-entry export "${name}" missing from ./postgres`).toHaveProperty(name);
  }
});

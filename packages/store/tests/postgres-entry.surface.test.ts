import { expect, it } from "vitest";
import * as mainEntry from "../src/index.js";
import * as postgresEntry from "../src/postgres.js";
import type { Db as MainDb, Query as MainQuery } from "../src/index.js";
import type { Db as PostgresDb, Query as PostgresQuery } from "../src/postgres.js";

// Separate file from postgres-entry.test.ts on purpose: importing the main
// entry legitimately loads PGlite, which that file's tripwire mock forbids.
it("./postgres mirrors the main entry's engine-agnostic surface", () => {
  for (const name of Object.keys(mainEntry)) {
    expect(postgresEntry, `main-entry export "${name}" missing from ./postgres`).toHaveProperty(name);
  }
});

// The parity check above only reads the MAIN entry's keys, so a ./postgres-only
// export slips past it. The Db seam is the console's whole entry point into this
// package — pin it on both entries by name.
it("exports the Db seam from both entries", () => {
  expect(mainEntry.createStoreForDb).toBeTypeOf("function");
  expect(postgresEntry.createStoreForDb).toBeTypeOf("function");
});

// Type-only exports never appear in Object.keys, so no runtime check can see them.
// These aliases are the pin: dropping Db or Query from either entry fails typecheck.
export type PinnedDb = [MainDb, PostgresDb];
export type PinnedQuery = [MainQuery, PostgresQuery];

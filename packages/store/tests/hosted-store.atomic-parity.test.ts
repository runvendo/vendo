import { ENGINE_COLLECTIONS, engineAppHistory } from "@vendoai/core";
import { afterAll, describe, expect, it } from "vitest";
import { hostedStore } from "../src/hosted-store.js";
import { createStore } from "../src/index.js";

// `records(collection).atomic` is a FEATURE-DETECTION signal (01-core §12):
// callers branch on its presence, so the hosted client must answer for every
// engine collection exactly what the local engine answers. hosted-store.ts
// hand-maintains that mirror; this test is the thing that holds it to reality.
// The ONE source of truth is the local engine's own door — nothing here reads
// the mirror's list — so a collection that gains or loses guarded writes in
// routing.ts fails here until the mirror follows.
//
// Neither door queries at construction, so this needs no schema and never
// boots PGlite or opens a socket.
const local = createStore({ dataDir: "memory://atomic-parity" });
const hosted = hostedStore({ apiKey: "vnd_secret", baseUrl: "https://cloud.test" });

afterAll(async () => {
  await local.close();
});

// Every collection the engine door serves: the allowlist, plus the one dynamic
// name its pattern admits.
const collections = [...ENGINE_COLLECTIONS, engineAppHistory("app_1")];
const localAtomic = (collection: string) => local.records(collection).atomic !== undefined;

describe("hostedStore mirrors the local engine's atomic capability", () => {
  it.each(collections)("%s", (collection) => {
    expect(hosted.records(collection).atomic !== undefined).toBe(localAtomic(collection));
  });

  // Guards the comparison against going vacuous: if the engine ever answered
  // the same for everything, every case above would pass while proving nothing.
  it("compares a set the engine genuinely splits", () => {
    const atomic = collections.filter(localAtomic);
    expect(atomic.length).toBeGreaterThan(0);
    expect(atomic.length).toBeLessThan(collections.length);
  });
});

import {
  ENGINE_COLLECTION_REGISTRY,
  ENGINE_COLLECTIONS,
  isEngineCollection,
  type EngineCollectionSpec,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { DEDICATED_RECORD_COLLECTIONS, RESERVED_COLLECTIONS } from "../src/index.js";

// The engine allowlist is a hand-maintained LITERAL in @vendoai/core: core
// imports nothing (layering, scripts/dependency-guard.mjs), so it cannot read
// the store's real routing constants. @vendoai/store can see both, so this test
// is the thing that holds the literal to reality — it fails the day someone
// adds a reserved or dedicated collection and forgets the list.

const allowed = new Set<string>(ENGINE_COLLECTIONS);

describe("engine allowlist mirrors the store's routing constants", () => {
  it.each(RESERVED_COLLECTIONS)("reserved %s is an engine collection", (collection) => {
    expect(allowed.has(collection)).toBe(true);
    expect(isEngineCollection(collection)).toBe(true);
  });

  it.each(DEDICATED_RECORD_COLLECTIONS)("dedicated %s is an engine collection", (collection) => {
    expect(allowed.has(collection)).toBe(true);
    expect(isEngineCollection(collection)).toBe(true);
  });

  // A watermark walk reaches its rows through `configFor` (routing.ts
  // watermarkPage), which knows only the RESERVED tables — so a collection that
  // declared an indexed field WITHOUT owning one of those doors would pass
  // `assertIndexedField` and then find nothing to read. This is what says so on
  // the day a second indexed field is declared.
  it("declares indexed fields only on collections that own a reserved door", () => {
    const registry = ENGINE_COLLECTION_REGISTRY as Record<string, EngineCollectionSpec>;
    for (const [collection, spec] of Object.entries(registry)) {
      if (spec.indexed === undefined) continue;
      expect((RESERVED_COLLECTIONS as readonly string[]).includes(collection), collection).toBe(true);
    }
  });

  // vendo_secrets is deliberately absent: it has zero .records() call sites and
  // is served only by the dedicated secretStore door (src/secrets.ts), so the
  // engine family must never be a second way in.
  it("does not allow vendo_secrets", () => {
    expect(allowed.has("vendo_secrets")).toBe(false);
    expect(isEngineCollection("vendo_secrets")).toBe(false);
  });
});

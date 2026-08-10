import { ENGINE_COLLECTIONS, isEngineCollection } from "@vendoai/core";
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

  // vendo_secrets is deliberately absent: it has zero .records() call sites and
  // is served only by the dedicated secretStore door (src/secrets.ts), so the
  // engine family must never be a second way in.
  it("does not allow vendo_secrets", () => {
    expect(allowed.has("vendo_secrets")).toBe(false);
    expect(isEngineCollection("vendo_secrets")).toBe(false);
  });
});

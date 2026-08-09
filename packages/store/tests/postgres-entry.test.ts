import { describe, expect, it, vi } from "vitest";

// Tripwire, not a stub: the factory only runs if something in the entry's
// module graph actually imports PGlite — which is exactly the regression this
// suite exists to catch (a Cloudflare Worker importing the main entry
// silently crossed the bundle size ceiling carrying wasm it can't run). The
// dist-level counterpart (esbuild metafile over dist/postgres.js) lives in
// scripts/portability-gate.mjs.
vi.mock("@electric-sql/pglite", () => {
  throw new Error("@vendoai/store/postgres must never load @electric-sql/pglite");
});

describe("@vendoai/store/postgres entry", () => {
  it("imports and constructs a store without PGlite in the module graph", async () => {
    const { createStore } = await import("../src/postgres.js");
    const store = createStore({ url: "postgres://vendo:vendo@localhost:5432/never-connected" });
    expect(typeof store.records).toBe("function");
    expect(typeof store.ensureSchema).toBe("function");
    await store.close();
  });

  it("refuses to construct without a Postgres url", async () => {
    const { createStore } = await import("../src/postgres.js");
    expect(() => createStore({ url: "" })).toThrowError(/Postgres connection string/);
  });

  const url = process.env.POSTGRES_URL;
  it.skipIf(!url)("runs schema + record roundtrip on real Postgres", async () => {
    const { createStore } = await import("../src/postgres.js");
    const store = createStore({ url: url as string });
    try {
      await store.ensureSchema();
      const records = store.records("postgres_entry_smoke");
      const put = await records.put({ id: "smoke_1", data: { via: "postgres entry" } });
      expect(await records.get("smoke_1")).toEqual(put);
      await records.delete("smoke_1");
      expect(await records.get("smoke_1")).toBeNull();
    } finally {
      await store.close();
    }
  });
});

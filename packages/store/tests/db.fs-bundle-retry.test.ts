import { beforeEach, describe, expect, it, vi } from "vitest";

// A PGlite boot re-reads its ~6MB wasm FS bundle out of node_modules every
// time, and pnpm links that file to its shared store — so an external rewrite
// of the store's copy shows up here as a transiently truncated read, which
// pglite reports as `Invalid FS bundle size` (seen on CI 2026-08-16: 12 of 13
// boots in one file succeeded). The engine is mocked so the truncated read is
// deterministic; the retry logic is the subject.
const pgliteCreate = vi.fn();
vi.mock("@electric-sql/pglite", () => ({
  PGlite: { create: (...args: unknown[]) => pgliteCreate(...args) },
}));

const { createDb } = await import("../src/db.js");

const truncatedBundle = () => new Error("Invalid FS bundle size: 3030528 !== 6293225");
const fakePglite = () => ({
  query: vi.fn(async () => ({ rows: [{ ok: 1 }] })),
  close: vi.fn(async () => {}),
});

// memory:// keeps the subject alone: no data dir, so neither the writer lock
// nor the stale-postmaster.pid heal has anything to say about these failures.
describe("PGlite truncated FS bundle retry", () => {
  beforeEach(() => {
    pgliteCreate.mockReset();
  });

  it("heals a transiently truncated bundle read with one retry", async () => {
    pgliteCreate.mockRejectedValueOnce(truncatedBundle()).mockResolvedValueOnce(fakePglite());

    const db = createDb({ dataDir: "memory://fs-bundle-heals" });
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });

    expect(pgliteCreate).toHaveBeenCalledTimes(2);
    await db.close();
  });

  it("tells the operator to reinstall when the bundle reads short twice", async () => {
    pgliteCreate.mockRejectedValue(truncatedBundle());

    const db = createDb({ dataDir: "memory://fs-bundle-truly-truncated" });
    const error = await db.query("select 1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("[vendo]");
    expect((error as Error).message).toContain("Reinstall dependencies");
    expect((error as Error).message).toContain("Invalid FS bundle size: 3030528 !== 6293225");
    expect(pgliteCreate).toHaveBeenCalledTimes(2);
    await db.close();
  });

  it("propagates an unrelated boot failure unchanged, without retrying", async () => {
    pgliteCreate.mockRejectedValue(new Error("boot blip"));

    const db = createDb({ dataDir: "memory://fs-bundle-unrelated" });
    await expect(db.query("select 1")).rejects.toThrow("boot blip");

    expect(pgliteCreate).toHaveBeenCalledTimes(1);
    await db.close();
  });
});

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
const initFailure = () => new Error("PGlite failed to initialize properly");
const unloadableLibrary = () =>
  new Error(
    'error: could not load library "/pglite/lib/postgresql/plpgsql.so": Could not load dynamic lib: /pglite/lib/postgresql/plpgsql.so',
  );
const mixedVersionBundle = () =>
  new Error(
    'INITDB failed to initialize: initdb: error: input file "/pglite/share/postgresql/postgres.bki" does not belong to PostgreSQL 18.3initdb: hint: Specify the correct path using the option -L.',
  );
const fakePglite = () => ({
  query: vi.fn(async () => ({ rows: [{ ok: 1 }] })),
  close: vi.fn(async () => {}),
});

// memory:// keeps the subject alone: no data dir, so neither the writer lock
// nor the stale-postmaster.pid heal has anything to say about these failures.
describe("PGlite transient boot retry", () => {
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

  // The CI flake this second signature exists for: one memory:// store in a
  // ~300-test file loses its wasm boot, with no lock file and no short read to
  // heal (`tests/session.test.ts` on run 32311392574, `tests/interruptions.test.ts`
  // on run 32234929102 — byte-identical stack, different random victim).
  it("heals a transient wasm init failure with one retry", async () => {
    pgliteCreate.mockRejectedValueOnce(initFailure()).mockResolvedValueOnce(fakePglite());

    const db = createDb({ dataDir: "memory://boot-init-heals" });
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });

    expect(pgliteCreate).toHaveBeenCalledTimes(2);
    await db.close();
  });

  // Bounded, and honest about the cause: a second init failure is believed, and
  // only the truncated-bundle case is reworded — this one keeps its own message.
  it("gives up after one retry and keeps a permanent init failure's own message", async () => {
    pgliteCreate.mockRejectedValue(initFailure());

    const db = createDb({ dataDir: "memory://boot-init-permanent" });
    const error = await db.query("select 1").catch((caught: unknown) => caught);

    expect((error as Error).message).toBe("PGlite failed to initialize properly");
    expect((error as Error).message).not.toContain("Reinstall dependencies");
    expect(pgliteCreate).toHaveBeenCalledTimes(2);
    await db.close();
  });

  // The same half-written install wearing two other faces (CI 2026-08-19): a
  // `.so` in the bundle that dlopen cannot read, and an initdb input file left
  // over from another version. Both hit `packages/agents` on a random test.
  it("heals a bundle library that fails to load, with one retry", async () => {
    pgliteCreate.mockRejectedValueOnce(unloadableLibrary()).mockResolvedValueOnce(fakePglite());

    const db = createDb({ dataDir: "memory://boot-library-heals" });
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });

    expect(pgliteCreate).toHaveBeenCalledTimes(2);
    await db.close();
  });

  it("heals a version-mixed initdb input file, with one retry", async () => {
    pgliteCreate.mockRejectedValueOnce(mixedVersionBundle()).mockResolvedValueOnce(fakePglite());

    const db = createDb({ dataDir: "memory://boot-bki-heals" });
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });

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

  // The library signature is pinned to the bundle's own path: a host extension
  // that fails to load is the host's problem, and retrying it just doubles it.
  it("propagates a failed load of a library outside the bundle, without retrying", async () => {
    pgliteCreate.mockRejectedValue(
      new Error('could not load library "/usr/lib/postgresql/vector.so"'),
    );

    const db = createDb({ dataDir: "memory://boot-host-library" });
    await expect(db.query("select 1")).rejects.toThrow("/usr/lib/postgresql/vector.so");

    expect(pgliteCreate).toHaveBeenCalledTimes(1);
    await db.close();
  });
});

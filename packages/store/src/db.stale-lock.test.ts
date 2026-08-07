import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ENG-350 — a dev server killed uncleanly leaves postmaster.pid in the PGlite
// data dir, and in the field PGlite.create can then hard-abort with a raw
// `Aborted()` (electric-sql/pglite#2, #794). The real wasm engine is mocked so
// the abort is deterministic; the lock-file staleness logic runs against a
// real temp dir.
const pgliteCreate = vi.fn();
vi.mock("@electric-sql/pglite", () => ({
  PGlite: { create: (...args: unknown[]) => pgliteCreate(...args) },
}));

const { createDb } = await import("./db.js");

const aborted = () => Object.assign(new Error("Aborted(). Build with -sASSERTIONS for more info."), { name: "RuntimeError" });
const fakePglite = () => ({
  query: vi.fn(async () => ({ rows: [{ ok: 1 }] })),
  close: vi.fn(async () => {}),
});

// PGlite's wasm postgres always records Emscripten's fake pid (-42) — a
// non-positive pid can never belong to a live owner.
const STALE_LOCK = "-42\n/pglite/data\n1784193130\n5432\n\n\n317123000         1\n";

describe("PGlite stale-lock self-heal (ENG-350)", () => {
  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vendo-stale-lock-"));
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pgliteCreate.mockReset();
  });

  afterEach(async () => {
    warn.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it("heals a stale postmaster.pid and retries once", async () => {
    await writeFile(join(dir, "postmaster.pid"), STALE_LOCK);
    pgliteCreate.mockRejectedValueOnce(aborted()).mockResolvedValueOnce(fakePglite());

    const db = createDb({ dataDir: dir });
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });

    expect(pgliteCreate).toHaveBeenCalledTimes(2);
    expect(existsSync(join(dir, "postmaster.pid"))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stale postmaster.pid"));
    await db.close();
  });

  it("refuses to delete a lock recording a live process", async () => {
    // This test process itself is the recorded owner — definitionally alive.
    await writeFile(join(dir, "postmaster.pid"), `${process.pid}\n/pglite/data\n1784193130\n5432\n`);
    pgliteCreate.mockRejectedValue(aborted());

    const db = createDb({ dataDir: dir });
    await expect(db.query("select 1")).rejects.toThrow(new RegExp(`live process \\(pid ${process.pid}\\)`));

    expect(pgliteCreate).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, "postmaster.pid"))).toBe(true);
    await db.close();
  });

  it("surfaces an actionable error when the retry also fails", async () => {
    await writeFile(join(dir, "postmaster.pid"), STALE_LOCK);
    pgliteCreate.mockRejectedValue(aborted());

    const db = createDb({ dataDir: dir });
    const error = await db.query("select 1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`[vendo] PGlite data directory "${dir}"`);
    expect((error as Error).message).toContain("likely corrupt");
    expect((error as Error).message).toContain("Aborted()");
    expect(pgliteCreate).toHaveBeenCalledTimes(2);
    await db.close();
  });

  it("propagates the original error when there is no lock file to heal", async () => {
    pgliteCreate.mockRejectedValue(aborted());

    const db = createDb({ dataDir: dir });
    await expect(db.query("select 1")).rejects.toThrow("Aborted()");

    expect(pgliteCreate).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    await db.close();
  });
});

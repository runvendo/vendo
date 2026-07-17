import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ENG-351 — under `next dev`, more than one process (transient Turbopack
// evaluator workers, HMR-duplicated module graphs) evaluates the host's server
// module and opens PGlite on the SAME data dir. PGlite has no cross-process
// locking, so the second instance's startup writes tear the first one's WAL —
// the dir reopens with a raw `Aborted()` and every recent turn is lost. The
// store must enforce single-writer discipline itself: one live driver per dir
// in-process, and a sibling lock file that makes a second process WAIT (not
// corrupt) until the holder is gone. The wasm engine is mocked; the lock and
// registry logic run against the real filesystem.
const pgliteCreate = vi.fn();
vi.mock("@electric-sql/pglite", () => ({
  PGlite: { create: (...args: unknown[]) => pgliteCreate(...args) },
}));

const { createDb } = await import("./db.js");

const fakePglite = () => ({
  query: vi.fn(async () => ({ rows: [{ ok: 1 }] })),
  close: vi.fn(async () => {}),
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves "pending" if the promise has not settled within `ms`. */
const settledWithin = (promise: Promise<unknown>, ms: number): Promise<unknown> =>
  Promise.race([promise.then(() => "settled", () => "settled"), wait(ms).then(() => "pending")]);

const lockPathFor = (dir: string): string => `${dir}.lock`;

describe("PGlite single-writer discipline (ENG-351)", () => {
  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;
  let sleeper: ChildProcess | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vendo-single-writer-"));
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pgliteCreate.mockReset();
  });

  afterEach(async () => {
    warn.mockRestore();
    if (sleeper && sleeper.exitCode === null) sleeper.kill("SIGKILL");
    sleeper = undefined;
    await rm(dir, { recursive: true, force: true });
    await rm(lockPathFor(dir), { force: true });
  });

  it("reuses one live driver for two handles on the same dataDir", async () => {
    pgliteCreate.mockResolvedValue(fakePglite());
    const first = createDb({ dataDir: dir });
    const second = createDb({ dataDir: dir });

    await expect(first.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
    await expect(second.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(pgliteCreate).toHaveBeenCalledTimes(1);

    // Closing one handle must not tear down the driver under the other.
    await first.close();
    await expect(second.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
    await second.close();
  });

  it("holds a sibling lock file while open and releases it on close", async () => {
    pgliteCreate.mockResolvedValue(fakePglite());
    const db = createDb({ dataDir: dir });
    await db.query("select 1");

    expect(existsSync(lockPathFor(dir))).toBe(true);
    expect(readFileSync(lockPathFor(dir), "utf8")).toContain(String(process.pid));

    await db.close();
    expect(existsSync(lockPathFor(dir))).toBe(false);
  });

  it("waits for a live holder instead of opening a second instance, then takes over when it dies", async () => {
    // A real live process (not this one) holds the lock.
    sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(lockPathFor(dir), `${sleeper.pid}\n`);
    pgliteCreate.mockResolvedValue(fakePglite());

    const db = createDb({ dataDir: dir });
    const query = db.query("select 1");
    await expect(settledWithin(query, 800)).resolves.toBe("pending");
    expect(pgliteCreate).not.toHaveBeenCalled();

    sleeper.kill("SIGKILL");
    await expect(query).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(pgliteCreate).toHaveBeenCalledTimes(1);
    // The lock now records this process.
    expect(readFileSync(lockPathFor(dir), "utf8")).toContain(String(process.pid));
    await db.close();
  });

  it("steals a lock left by a dead process without waiting", async () => {
    // Spawn-and-reap a child so the recorded pid is definitely dead.
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => dead.once("exit", resolve));
    writeFileSync(lockPathFor(dir), `${dead.pid}\n`);
    pgliteCreate.mockResolvedValue(fakePglite());

    const db = createDb({ dataDir: dir });
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(readFileSync(lockPathFor(dir), "utf8")).toContain(String(process.pid));
    await db.close();
  });

  it("recovers a lock recording its own pid (crash-and-restart pid reuse)", async () => {
    writeFileSync(lockPathFor(dir), `${process.pid}\n`);
    pgliteCreate.mockResolvedValue(fakePglite());

    const db = createDb({ dataDir: dir });
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
    await db.close();
  });

  it("retries a failed open instead of caching the rejection", async () => {
    pgliteCreate.mockRejectedValueOnce(new Error("boot blip")).mockResolvedValueOnce(fakePglite());

    const db = createDb({ dataDir: dir });
    await expect(db.query("select 1")).rejects.toThrow("boot blip");
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
    // The failed attempt must not leave a lock behind for the retry to fight.
    await db.close();
    expect(existsSync(lockPathFor(dir))).toBe(false);
  });
});

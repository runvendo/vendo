import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPgPool, createVendoDatabase, migrateVendoDatabase } from "./db.js";
import { vi } from "vitest";

let savedEnv: NodeJS.ProcessEnv;
let suffix = 0;

/** Unique memory:// dataDir per test so the process-wide registry never collides. */
function uniqueDataDir(): string {
  suffix += 1;
  return `memory://db-test-${Date.now()}-${suffix}`;
}

beforeEach(() => {
  savedEnv = { ...process.env };
});

afterEach(() => {
  process.env = savedEnv;
});

describe("createVendoDatabase", () => {
  it("returns the same handle (promise identity) for repeated calls with the same config", async () => {
    const config = { pglite: { dataDir: uniqueDataDir() } };
    const p1 = createVendoDatabase(config);
    const p2 = createVendoDatabase(config);
    expect(p2).toBe(p1);
    const [h1, h2] = await Promise.all([p1, p2]);
    expect(h2).toBe(h1);
  });

  it("rejects mentioning DATABASE_URL when VERCEL is set and no connection string is configured", async () => {
    delete process.env["DATABASE_URL"];
    process.env["VERCEL"] = "1";
    await expect(createVendoDatabase({ pglite: { dataDir: uniqueDataDir() } })).rejects.toThrow(/DATABASE_URL/);
  });

  it("honors VENDO_DATA_DIR when no explicit dataDir is passed", async () => {
    const dataDir = uniqueDataDir();
    process.env["VENDO_DATA_DIR"] = dataDir;
    delete process.env["DATABASE_URL"];
    const handle = await createVendoDatabase();
    expect(handle.kind).toBe("pglite");
    expect(handle.cacheKey).toBe(`pglite:${dataDir}`);
  });

  it("prefers an explicitly passed pglite config over an ambient DATABASE_URL env var", async () => {
    const dataDir = uniqueDataDir();
    process.env["DATABASE_URL"] = "postgres://env-host:5432/env-db";
    const handle = await createVendoDatabase({ pglite: { dataDir } });
    expect(handle.kind).toBe("pglite");
    expect(handle.cacheKey).toBe(`pglite:${dataDir}`);
  });

  it("prefers an explicit connectionString over an explicit pglite config", async () => {
    // Precedence only — never connect: assert the handle KIND without awaiting
    // any query against the (nonexistent) server.
    const handle = await createVendoDatabase({
      connectionString: "postgres://explicit-host:5432/explicit-db",
      pglite: { dataDir: uniqueDataDir() },
    });
    expect(handle.kind).toBe("pg");
    expect(handle.cacheKey).toBe("postgres://explicit-host:5432/explicit-db");
  });

  it("rejects loudly when the pglite dataDir is not writable", async () => {
    // Fixture dir deliberately named WITHOUT the substring "writable" so the
    // assertion can only match the code's own error message, not the path.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vendo-store-test-"));
    const dataDir = path.join(parent, "locked");
    fs.mkdirSync(dataDir);
    fs.chmodSync(dataDir, 0o444);
    try {
      await expect(createVendoDatabase({ pglite: { dataDir } })).rejects.toThrow(/is not writable/);
    } finally {
      fs.chmodSync(dataDir, 0o755);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("migrateVendoDatabase", () => {
  it("is idempotent — running it twice on the same handle both resolve", async () => {
    const handle = await createVendoDatabase({ pglite: { dataDir: uniqueDataDir() } });
    await expect(migrateVendoDatabase(handle)).resolves.toBeUndefined();
    await expect(migrateVendoDatabase(handle)).resolves.toBeUndefined();
  });
});

describe("createPgPool", () => {
  it("survives an idle-connection 'error' event instead of crashing the process", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = createPgPool("postgres://vendo:vendo@localhost:1/vendo");
    // pg.Pool re-emits idle client errors on itself; with no listener,
    // EventEmitter escalates to an uncaught exception and kills the host.
    expect(() => pool.emit("error", new Error("idle client lost connection"))).not.toThrow();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    void pool.end();
  });
});

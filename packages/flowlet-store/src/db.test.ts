import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFlowletDatabase, migrateFlowletDatabase } from "./db.js";

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

describe("createFlowletDatabase", () => {
  it("returns the same handle (promise identity) for repeated calls with the same config", async () => {
    const config = { pglite: { dataDir: uniqueDataDir() } };
    const p1 = createFlowletDatabase(config);
    const p2 = createFlowletDatabase(config);
    expect(p2).toBe(p1);
    const [h1, h2] = await Promise.all([p1, p2]);
    expect(h2).toBe(h1);
  });

  it("rejects mentioning DATABASE_URL when VERCEL is set and no connection string is configured", async () => {
    delete process.env["DATABASE_URL"];
    process.env["VERCEL"] = "1";
    await expect(createFlowletDatabase({ pglite: { dataDir: uniqueDataDir() } })).rejects.toThrow(/DATABASE_URL/);
  });

  it("honors FLOWLET_DATA_DIR when no explicit dataDir is passed", async () => {
    const dataDir = uniqueDataDir();
    process.env["FLOWLET_DATA_DIR"] = dataDir;
    delete process.env["DATABASE_URL"];
    const handle = await createFlowletDatabase();
    expect(handle.kind).toBe("pglite");
    expect(handle.cacheKey).toBe(`pglite:${dataDir}`);
  });

  it("rejects loudly when the pglite dataDir is not writable", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "flowlet-store-test-"));
    const dataDir = path.join(parent, "unwritable");
    fs.mkdirSync(dataDir);
    fs.chmodSync(dataDir, 0o444);
    try {
      await expect(createFlowletDatabase({ pglite: { dataDir } })).rejects.toThrow(/writable/i);
    } finally {
      fs.chmodSync(dataDir, 0o755);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("migrateFlowletDatabase", () => {
  it("is idempotent — running it twice on the same handle both resolve", async () => {
    const handle = await createFlowletDatabase({ pglite: { dataDir: uniqueDataDir() } });
    await expect(migrateFlowletDatabase(handle)).resolves.toBeUndefined();
    await expect(migrateFlowletDatabase(handle)).resolves.toBeUndefined();
  });
});

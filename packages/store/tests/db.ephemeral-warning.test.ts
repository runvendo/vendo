import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db.js";
import { createStore } from "../src/create-store.js";
import { maybeDbFor } from "../src/store.js";

// A container platform runs a long-lived process, so PGlite WORKS there — right
// up to the next deploy, which deletes the whole filesystem and with it every
// app the product's users built. The store cannot refuse (unlike VERCEL and
// friends, where PGlite cannot run at all), so it carries the judgment as a fact
// on the handle and the deployment that composed it says it once, at boot
// (createVendo's ⚠ store row — packages/vendo/src/boot-summary.ts).

const TMP_DATA_DIR = join(tmpdir(), "vendo-ephemeral-warning", "data");
// A path with a real disk under it: the laptop case that must stay silent.
const LAPTOP_DATA_DIR = "/home/dev/maple/.vendo/data";

describe("PGlite ephemeral-disk judgment", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  it("flags a data dir under the OS temp dir, naming it as configured", () => {
    expect(createDb({ dataDir: TMP_DATA_DIR }).ephemeral).toEqual({ dataDir: TMP_DATA_DIR });
  });

  it.each([
    ["RAILWAY_ENVIRONMENT", "production", "Railway"],
    ["RENDER", "true", "Render"],
    ["FLY_APP_NAME", "maple", "Fly.io"],
    ["DYNO", "web.1", "Heroku"],
  ])("names %s's platform even with a normal-looking data dir", (marker, value, platform) => {
    vi.stubEnv(marker, value);

    expect(createDb({ dataDir: LAPTOP_DATA_DIR }).ephemeral)
      .toEqual({ dataDir: LAPTOP_DATA_DIR, platform });
  });

  it("says nothing for an ordinary laptop path, the default, memory:// or a url", () => {
    expect(createDb({ dataDir: LAPTOP_DATA_DIR }).ephemeral).toBeUndefined();
    // The .vendo/data default, resolved against this repo's cwd.
    expect(createDb({}).ephemeral).toBeUndefined();
    expect(createDb({ dataDir: "memory://silent" }).ephemeral).toBeUndefined();
    expect(createDb({ url: "postgres://user@host/db" }).ephemeral).toBeUndefined();
  });

  // The store is not the one that talks to the operator: printing here and
  // rendering the same judgment in the boot block said it twice.
  it("never prints it itself", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT", "production");
    createDb({ dataDir: TMP_DATA_DIR });
    expect(warn).not.toHaveBeenCalled();
  });

  // The SEAM the boot block reads through: a real createStore handle in, the
  // judgment out, with nothing stubbed on either side.
  it("reaches a composed store handle through maybeDbFor", () => {
    expect(maybeDbFor(createStore({ dataDir: TMP_DATA_DIR }))?.ephemeral)
      .toEqual({ dataDir: TMP_DATA_DIR });
    expect(maybeDbFor(createStore({ dataDir: LAPTOP_DATA_DIR }))?.ephemeral).toBeUndefined();
  });

  it("still hard-refuses a serverless platform instead of flagging it", async () => {
    vi.stubEnv("VERCEL", "1");

    const db = createDb({ dataDir: TMP_DATA_DIR });
    await expect(db.query("select 1")).rejects.toThrow(/PGlite cannot run on VERCEL/);
    await db.close();
  });
});

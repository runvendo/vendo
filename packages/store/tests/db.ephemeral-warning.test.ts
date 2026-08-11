import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db.js";

// A container platform runs a long-lived process, so PGlite WORKS there — right
// up to the next deploy, which deletes the whole filesystem and with it every
// app the product's users built. The store cannot refuse (unlike VERCEL and
// friends, where PGlite cannot run at all), so boot warns instead.

const TMP_DATA_DIR = join(tmpdir(), "vendo-ephemeral-warning", "data");
// A path with a real disk under it: the laptop case that must stay silent.
const LAPTOP_DATA_DIR = "/home/dev/maple/.vendo/data";

describe("PGlite ephemeral-disk warning", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  const warning = (): string => String(warn.mock.calls[0]?.[0] ?? "");

  it("warns when the data dir is under the OS temp dir", () => {
    createDb({ dataDir: TMP_DATA_DIR });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warning()).toBe(
      `[vendo] warning: the store is writing to ${JSON.stringify(TMP_DATA_DIR)}, which this platform wipes on every`
      + " redeploy — your users' apps and data will be gone. Mount a persistent volume and point dataDir at it,"
      + ' or pass url: "postgres://…" to createVendo.',
    );
  });

  it.each([
    ["RAILWAY_ENVIRONMENT", "production", "Railway"],
    ["RENDER", "true", "Render"],
    ["FLY_APP_NAME", "maple", "Fly.io"],
    ["DYNO", "web.1", "Heroku"],
  ])("warns on %s even with a normal-looking data dir", (marker, value, platform) => {
    vi.stubEnv(marker, value);

    createDb({ dataDir: LAPTOP_DATA_DIR });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warning()).toContain(`and ${platform} wipes the container filesystem on every redeploy`);
    expect(warning()).toContain(JSON.stringify(LAPTOP_DATA_DIR));
  });

  it("stays silent for an ordinary laptop path", () => {
    createDb({ dataDir: LAPTOP_DATA_DIR });
    createDb({}); // the .vendo/data default, resolved against this repo's cwd
    createDb({ dataDir: "memory://silent" });

    expect(warn).not.toHaveBeenCalled();
  });

  it("still hard-refuses a serverless platform instead of warning", async () => {
    vi.stubEnv("VERCEL", "1");

    const db = createDb({ dataDir: TMP_DATA_DIR });
    await expect(db.query("select 1")).rejects.toThrow(/PGlite cannot run on VERCEL/);
    await db.close();
  });
});

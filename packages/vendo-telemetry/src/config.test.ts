import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, configPath, configDir } from "./config.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vendo-tele-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("config store", () => {
  // These pass an explicit empty env: loadConfig defaults to process.env, and
  // under a real CI runner CI=true is an env opt-out (ephemeral config, nothing
  // persisted), which is exactly the behavior the "(review)" cases below pin.
  it("creates a random anonymous id on first load", () => {
    const c = loadConfig(home, {});
    expect(c.anonymousId).toMatch(/[0-9a-f-]{36}/);
    expect(c.optedOut).toBe(false);
    expect(c.noticeShown).toBe(false);
    expect(existsSync(configPath(home))).toBe(true);
  });

  it("returns the same id on subsequent loads", () => {
    const a = loadConfig(home, {});
    const b = loadConfig(home, {});
    expect(b.anonymousId).toBe(a.anonymousId);
  });

  it("persists updates", () => {
    const c = loadConfig(home, {});
    saveConfig(home, { ...c, optedOut: true, noticeShown: true });
    const reread = loadConfig(home, {});
    expect(reread.optedOut).toBe(true);
    expect(reread.noticeShown).toBe(true);
  });

  it("honors a hand-written opt-out even without an anonymous id (review)", () => {
    mkdirSync(configDir(home), { recursive: true });
    writeFileSync(configPath(home), JSON.stringify({ optedOut: true }), "utf8");
    const c = loadConfig(home);
    expect(c.optedOut).toBe(true);
  });

  it("does not mint or persist a tracking id when an env opt-out is set (review)", () => {
    const c = loadConfig(home, { DO_NOT_TRACK: "1" });
    expect(c.optedOut).toBe(true);
    expect(existsSync(configPath(home))).toBe(false);
  });

  it("still writes a normal opted-in config on first run without env opt-out (review)", () => {
    const c = loadConfig(home, {});
    expect(c.optedOut).toBe(false);
    expect(existsSync(configPath(home))).toBe(true);
  });

  it("degrades to an in-memory config when the config dir can't be written (review)", () => {
    // Make configDir un-creatable: a file where the .vendo parent must be a dir.
    const badHome = join(home, "as-file");
    writeFileSync(badHome, "x", "utf8"); // badHome/.vendo/... → ENOTDIR on mkdir
    const c = loadConfig(badHome, {});
    expect(c.anonymousId).toMatch(/[0-9a-f-]{36}/);
    expect(existsSync(configPath(badHome))).toBe(false);
  });
});

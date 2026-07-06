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
  it("creates a random anonymous id on first load", () => {
    const c = loadConfig(home);
    expect(c.anonymousId).toMatch(/[0-9a-f-]{36}/);
    expect(c.optedOut).toBe(false);
    expect(c.noticeShown).toBe(false);
    expect(existsSync(configPath(home))).toBe(true);
  });

  it("returns the same id on subsequent loads", () => {
    const a = loadConfig(home);
    const b = loadConfig(home);
    expect(b.anonymousId).toBe(a.anonymousId);
  });

  it("persists updates", () => {
    const c = loadConfig(home);
    saveConfig(home, { ...c, optedOut: true, noticeShown: true });
    const reread = loadConfig(home);
    expect(reread.optedOut).toBe(true);
    expect(reread.noticeShown).toBe(true);
  });

  it("honors a hand-written opt-out even without an anonymous id (review)", () => {
    mkdirSync(configDir(home), { recursive: true });
    writeFileSync(configPath(home), JSON.stringify({ optedOut: true }), "utf8");
    const c = loadConfig(home);
    expect(c.optedOut).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

describe("cli dispatch", () => {
  it("prints help and exits 0 with no command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main([])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("flowlet init");
    log.mockRestore();
  });

  it("exits 1 on unknown command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["frobnicate"])).toBe(1);
    log.mockRestore();
  });

  it("lists the sync command in help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main([]);
    expect(log.mock.calls.flat().join("\n")).toContain("flowlet sync");
    log.mockRestore();
  });

  it("runs sync against an empty dir (fresh install: captures nothing, exits 0)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "flowlet-cli-sync-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["sync", dir])).toBe(0);
    log.mockRestore();
  });
});

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
});

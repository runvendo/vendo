import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { main, parseInitArgs } from "./cli.js";
import { CLI_VERSION } from "./version.js";

describe("cli dispatch", () => {
  it("prints help and exits 0 with no command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main([])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("vendo init");
    log.mockRestore();
  });

  it("exits 1 on unknown command and prints usage", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["frobnicate"])).toBe(1);
    expect(log.mock.calls.flat().join("\n")).toContain("Usage:");
    log.mockRestore();
  });

  it("--version prints the real package version, not a hardcoded string", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["--version"])).toBe(0);
    expect(log.mock.calls.flat()).toContain(pkg.version);
    expect(log.mock.calls.flat()).toContain(CLI_VERSION);
    log.mockRestore();
  });

  it("lists the sync command in help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main([]);
    expect(log.mock.calls.flat().join("\n")).toContain("vendo sync");
    log.mockRestore();
  });

  it("runs sync against an empty dir (fresh install: captures nothing, exits 0)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "vendo-cli-sync-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["sync", dir])).toBe(0);
    log.mockRestore();
  });
});

describe("parseInitArgs", () => {
  it("accepts --yes and defaults it to false when absent", () => {
    const withYes = parseInitArgs(["some-dir", "--yes"]);
    expect(withYes).toMatchObject({ ok: true, yes: true });

    const withoutYes = parseInitArgs(["some-dir"]);
    expect(withoutYes).toMatchObject({ ok: true, yes: false });
  });
});

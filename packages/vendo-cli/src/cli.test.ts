import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isCliEntrypoint, main } from "./cli.js";

describe("cli dispatch", () => {
  it("prints help and exits 0 with no command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main([])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("vendo init");
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

describe("isCliEntrypoint", () => {
  // Simulates the layout npm creates: node_modules/@vendoai/cli/dist/cli.js
  // plus a node_modules/.bin/vendo symlink pointing at it.
  const setup = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vendo cli entry-")); // space on purpose
    const entry = path.join(dir, "dist", "cli.js");
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "// stub\n");
    // Node reports import.meta.url as the module's realpath (e.g. /var -> /private/var
    // on macOS), so build the fixture URL from the realpath too.
    return { dir, entry, metaUrl: pathToFileURL(realpathSync(entry)).href };
  };

  it("true when argv[1] is the module path itself", () => {
    const { entry, metaUrl } = setup();
    expect(isCliEntrypoint(metaUrl, entry)).toBe(true);
  });

  it("true when argv[1] is a symlink to the module (npm .bin shim)", () => {
    const { dir, entry, metaUrl } = setup();
    const bin = path.join(dir, ".bin");
    mkdirSync(bin);
    const shim = path.join(bin, "vendo");
    symlinkSync(entry, shim);
    expect(isCliEntrypoint(metaUrl, shim)).toBe(true);
  });

  it("true when the install path contains spaces", () => {
    const { entry, metaUrl } = setup(); // tmpdir already contains a space
    expect(entry).toContain(" ");
    expect(isCliEntrypoint(metaUrl, entry)).toBe(true);
  });

  it("false for an unrelated script path", () => {
    const { dir, metaUrl } = setup();
    const other = path.join(dir, "dist", "other.js");
    writeFileSync(other, "// other\n");
    expect(isCliEntrypoint(metaUrl, other)).toBe(false);
  });

  it("false when argv[1] is missing or nonexistent", () => {
    const { dir, metaUrl } = setup();
    expect(isCliEntrypoint(metaUrl, undefined)).toBe(false);
    expect(isCliEntrypoint(metaUrl, path.join(dir, "nope.js"))).toBe(false);
  });
});

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isCliEntrypoint, main, parseInitArgs } from "./cli.js";
import { CLI_VERSION } from "./version.js";

describe("cli dispatch", () => {
  it("prints help and exits 0 with no command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main([])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("vendo — Vendo one-click dev tool");
    log.mockRestore();
  });

  it("groups commands in help across the three tiers", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["--help"]);
    const help = log.mock.calls.flat().join("\n");
    expect(help).toContain("Setup (you run these):");
    expect(help).toContain("Runs automatically in your build:");
    expect(help).toContain("Management:");
    for (const cmd of ["init", "refresh", "doctor", "sync", "telemetry"]) {
      expect(help).toContain(cmd);
    }
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

  it("routes doctor to a read-only health check (unwired dir → exit 1)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "vendo-cli-doctor-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // An empty dir is not wired, so doctor reports hard failures and exits 1 —
    // this proves the `doctor` route reaches runDoctor.
    expect(await main(["doctor", dir])).toBe(1);
    log.mockRestore();
    err.mockRestore();
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

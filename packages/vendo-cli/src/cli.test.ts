import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { main, parseInitArgs } from "./cli.js";
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
    expect(help).toContain("Coming with the registry:");
    for (const cmd of ["init", "refresh", "doctor", "sync", "publish", "telemetry"]) {
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

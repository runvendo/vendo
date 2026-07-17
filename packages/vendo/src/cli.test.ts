import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vendo CLI commands", () => {
  it("keeps help aligned with the four-question init and its non-interactive flags", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await main(["--help"])).toBe(0);
    const help = log.mock.calls.flat().join("\n");
    expect(help).toContain("four questions");
    expect(help).toContain("--yes");
    expect(help).toContain("--force");
    expect(help).toContain("--model-import <specifier>");
    expect(help).toContain("--brief <text>");
    expect(help).toContain("--json");

    log.mockRestore();
  });

  it("exposes init, doctor, and sync only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["refresh"])).toBe(1);
    expect(await main(["telemetry", "status"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("Unknown command");
    error.mockRestore();
  });

  // ENG-335: an init flag the CLI does not recognize must fail loudly before
  // anything runs. The field incident was exactly this class — a CLI without
  // --agent silently dropped the flag and ran a full, writing init, breaking
  // the documented "agent mode writes nothing" promise.
  it("init rejects unknown options instead of silently proceeding (ENG-335)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), "vendo-cli-init-unknown-"));
    cleanup.push(root);

    expect(await main(["init", root, "--agent", "--dry-run"])).toBe(1);

    expect(error.mock.calls.flat().join("\n")).toContain("--dry-run");
    expect(log.mock.calls.flat().join("\n")).not.toContain('"framework"'); // init never ran
    expect(await readdir(root)).toEqual([]); // and wrote nothing

    // A value option with a missing value must not swallow the next flag
    // (Devin review): --dry-run is still reported as unknown.
    expect(await main(["init", root, "--agent", "--brief", "--dry-run"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--dry-run");

    // And a missing value before a KNOWN flag is rejected too (Greptile P1):
    // otherwise init proceeds — writing — with modelImport "--force".
    expect(await main(["init", root, "--yes", "--model-import", "--force"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--model-import requires a value");
    expect(await readdir(root)).toEqual([]);
    error.mockRestore();
    log.mockRestore();
  });

  it("init accepts every documented option, including = forms", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), "vendo-cli-init-known-"));
    cleanup.push(root);

    expect(await main([
      "init", root, "--agent", "--yes", "--force",
      "--model-import", "@/lib/ai", "--brief=host brief",
    ])).toBe(0);

    expect(await readdir(root)).toEqual([]); // --agent stayed read-only
    log.mockRestore();
    error.mockRestore();
  });

  it("wires the mcp subcommand group", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["mcp", "--help"])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("vendo mcp server-json");
    log.mockRestore();
  });
});

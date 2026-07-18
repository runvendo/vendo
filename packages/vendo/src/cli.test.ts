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
  it("keeps help aligned with the zero-question init and the two human verbs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await main(["--help"])).toBe(0);
    const help = log.mock.calls.flat().join("\n");
    expect(help).toContain("init [dir]");
    expect(help).toContain("doctor [dir]");
    expect(help).toContain("Advanced:");
    expect(help).toContain("--yes");
    expect(help).toContain("--force");
    expect(help).toContain("--agent");
    expect(help).toContain("--json");
    // The interview flags are gone with the interview.
    expect(help).not.toContain("--brief <text>");
    expect(help).not.toContain("Init/refine: module exporting");

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

    // Retired interview options are rejected loudly, not silently dropped.
    expect(await main(["init", root, "--agent", "--brief", "text"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--brief");
    expect(await readdir(root)).toEqual([]);
    error.mockRestore();
    log.mockRestore();
  });

  it("init accepts every documented option", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), "vendo-cli-init-known-"));
    cleanup.push(root);

    expect(await main(["init", root, "--agent", "--yes", "--force"])).toBe(0);

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

  it("wires eject: --list routes, surface + dir + --force parse, help documents it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await main(["--help"])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("eject");

    // Routing runs against the workspace @vendoai/ui (built templates).
    const root = await mkdtemp(join(tmpdir(), "vendo-cli-eject-"));
    cleanup.push(root);
    expect(await main(["eject", "--list", root])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("thread");

    expect(await main(["eject", "nope", root])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain('unknown surface "nope"');

    // surface + dir + --force all reach runEject: a second forced eject
    // over an existing directory succeeds instead of refusing.
    expect(await main(["eject", "thread", root])).toBe(0);
    expect(await main(["eject", "thread", root])).toBe(1);
    expect(await main(["eject", "thread", root, "--force"])).toBe(0);

    log.mockRestore();
    error.mockRestore();
  });
});

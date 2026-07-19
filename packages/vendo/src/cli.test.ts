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
    // Agent-install-dx: every init wizard question has a value-flag answer.
    expect(help).toContain("--auth <preset>");
    expect(help).toContain("--framework <name>");
    expect(help).toContain("--cloud-key <key>");
    expect(help).toContain("--byo");
    expect(help).toContain("--ai-polish");
    expect(help).toContain("--theme <slot=value>");
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

    expect(await main(["init", root, "--agent", "--yes", "--force", "--byo", "--ai-polish",
      "--auth", "clerk", "--framework", "next", "--theme", "accent=#7c3bed"])).toBe(0);

    expect(await readdir(root)).toEqual([]); // --agent stayed read-only
    // Value-flag values are never mistaken for the target dir, and the
    // --framework answer reaches the plan.
    const plan = JSON.parse(log.mock.calls.flat().join("\n")) as { root: string; framework: string };
    expect(plan.root).toBe(root);
    expect(plan.framework).toBe("next");

    // --cloud-key parses too — and --agent STILL writes nothing (the
    // read-only promise beats the key-landing side effect).
    expect(await main(["init", root, "--agent", "--cloud-key", `vnd_${"b".repeat(40)}`])).toBe(0);
    expect(await readdir(root)).toEqual([]);
    log.mockRestore();
    error.mockRestore();
  });

  // Agent-install-dx: a bad flag VALUE fails as loudly as an unknown flag —
  // an agent gets the valid values and an example instead of a silent guess.
  it("init value flags reject invalid values with the valid choices and an example", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), "vendo-cli-init-values-"));
    cleanup.push(root);

    expect(await main(["init", root, "--auth", "okta"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--auth must be one of authJs, clerk, supabase, auth0, jwt, none");

    expect(await main(["init", root, "--framework", "rails"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--framework must be next or express");

    expect(await main(["init", root, "--cloud-key", "not-a-key"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--cloud-key must be a Vendo Cloud key");

    expect(await main(["init", root, "--theme", "accent"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--theme takes slot=value");

    // The two answers to the one Cloud question are mutually exclusive.
    expect(await main(["init", root, "--cloud-key", `vnd_${"a".repeat(40)}`, "--byo"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--cloud-key and --byo answer the same question");

    expect(await readdir(root)).toEqual([]); // nothing ever ran
    error.mockRestore();
    log.mockRestore();
  });

  it("wires the mcp subcommand group", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["mcp", "--help"])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("vendo mcp server-json");
    log.mockRestore();
  });

  it("wires extract: --apply is required, unknown flags fail loudly, errors route home", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await main(["--help"])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("extract [dir]");
    expect(log.mock.calls.flat().join("\n")).toContain("--apply <draft.json>");

    // No --apply → loud error, nothing runs (ENG-335 posture).
    expect(await main(["extract"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--apply <draft.json> is required");

    // `--apply=` (empty value) fails loudly instead of resolving to the cwd.
    expect(await main(["extract", "--apply="])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--apply requires a value");

    expect(await main(["extract", "--apply", "draft.json", "--dry-run"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("unknown option: --dry-run");

    // A parsed --apply reaches the command: an un-inited dir fails honestly.
    const root = await mkdtemp(join(tmpdir(), "vendo-cli-extract-"));
    cleanup.push(root);
    expect(await main(["extract", root, "--apply", join(root, "draft.json")])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("run `vendo init` first");

    log.mockRestore();
    error.mockRestore();
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
    expect(log.mock.calls.flat().join("\n")).toContain("activities");

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

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

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
    expect(help).toContain("--ai");
    expect(help).toContain("--no-ai");
    expect(help).toContain("--theme <slot=value>");
    // The interview flags are gone with the interview.
    expect(help).not.toContain("--brief <text>");
    expect(help).not.toContain("Init/refine: module exporting");
    // vendo refine is gone (format v3: the AI layer moves to the
    // watermark-diff enrichment pass; misses capture/upload stays).
    expect(help).not.toContain("refine");
    expect(help).not.toContain("--model-import");
    expect(help).not.toContain("--ask");

    log.mockRestore();
  });

  it("vendo refine is no longer a command: retirement notice pointing at sync", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["refine"])).toBe(1);
    const output = error.mock.calls.flat().join("\n");
    expect(output).toContain("vendo refine was retired");
    expect(output).toContain("vendo sync");
    error.mockRestore();
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

    expect(await main(["init", root, "--agent", "--yes", "--force", "--byo", "--ai",
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
    expect(error.mock.calls.flat().join("\n")).toContain("--framework must be next, express, or custom");

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

  it("wires top-level login: help leads with it, ENG-335 guards apply", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await main(["--help"])).toBe(0);
    const help = log.mock.calls.flat().join("\n");
    expect(help).toContain("login");
    // login takes no --email/identity flag: the human chooses the account
    // on the approval page (removed 2026-07-21).
    expect(help).not.toContain("--email <address>");

    expect(await main(["login", "--emial", "x@y.z"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("unknown option: --emial");

    expect(await main(["login", "--email", "x@y.z"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("unknown option: --email");

    log.mockRestore();
    error.mockRestore();
  });

  it("wires the mcp subcommand group", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["mcp", "--help"])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("vendo mcp server-json");
    log.mockRestore();
  });

  it("no longer wires extract: the command and its usage lines are gone", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await main(["--help"])).toBe(0);
    const help = log.mock.calls.flat().join("\n");
    expect(help).not.toContain("extract [dir]");
    expect(help).not.toContain("--apply <draft.json>");

    // The judgment layer deleted the delegated-draft path (there is no draft to
    // apply any more). The command must fail as UNKNOWN rather than parse and
    // quietly do nothing.
    expect(await main(["extract"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("Unknown command: extract");

    log.mockRestore();
    error.mockRestore();
  });

  // ENG-335 applies to every command: doctor and sync must fail loudly on
  // unknown options too, and a flag-like next token is a missing value, not a
  // value — otherwise `vendo sync --key --report` pushes to Vendo Cloud
  // authenticated as the literal bearer key "--report".
  it("doctor/sync reject unknown options and flag-like values (ENG-335)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), "vendo-cli-guarded-"));
    cleanup.push(root);

    expect(await main(["sync", root, "--key", "--report"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--key requires a value");

    expect(await main(["doctor", root, "--url", "--json"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--url requires a value");

    expect(await main(["doctor", root, "--jsn"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("unknown option: --jsn");
    expect(await main(["sync", root, "--strictt"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("unknown option: --strictt");

    expect(await readdir(root)).toEqual([]); // nothing ever ran
    error.mockRestore();
  });

  // Decision 2: --ai/--no-ai is the canonical pair on BOTH commands; the older
  // documented spellings stay accepted so pinned scripts and the hooks older
  // inits wrote keep working, and the two answers can never both be given.
  it("accepts --ai/--no-ai on init and sync, keeps the legacy spellings, and rejects both at once", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), "vendo-cli-ai-flags-"));
    cleanup.push(root);

    // Parsed, not rejected (--agent keeps init read-only).
    for (const flag of ["--ai", "--no-ai", "--ai-polish"]) {
      expect(await main(["init", root, "--agent", flag])).toBe(0);
    }
    expect(await readdir(root)).toEqual([]);

    for (const flag of ["--ai", "--no-ai", "--no-watermark", "--yes", "--theme-refresh"]) {
      expect(await main(["sync", root, flag, "--json"])).toBe(0);
    }

    expect(await main(["init", root, "--ai", "--no-ai"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--ai and --no-ai answer the same question");
    expect(await main(["sync", root, "--ai", "--no-watermark"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--ai and --no-ai answer the same question");

    error.mockRestore();
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

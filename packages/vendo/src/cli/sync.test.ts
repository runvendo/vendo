import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PROJECT_ID_SALT } from "@vendoai/telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSync } from "./sync.js";
import { telemetryCapture } from "./telemetry.test-util.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const report = (
  breaking: Array<{ tool: string; change: "removed" }> = [],
  changed: string[] = [],
  toolSchemas: { total: number; inputs: { known: number; unknown: string[] }; outputs: { known: number; unknown: string[] } }
    = { total: 0, inputs: { known: 0, unknown: [] }, outputs: { known: 0, unknown: [] } },
) => ({
  tools: { added: [], removed: [], changed },
  breaking,
  pins: { captured: [], drifted: [] },
  remixableErrors: [],
  catalog: { discovered: 2, registered: 1 },
  components: { captured: [], drifted: [] },
  toolSchemas,
  warnings: [],
});

function captureOutput(): { output: { log(message: string): void; error(message: string): void }; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    output: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
    logs,
    errors,
  };
}

describe("vendo sync", () => {
  it("fails soft by default and exits two for strict breaking changes", async () => {
    const output = { log() {}, error() {} };
    const fetchImpl = async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [], automations: [], grants: 0 }],
    }), { status: 200 });
    expect(await runSync({ targetDir: ".", output, sync: async () => { throw new Error("scan"); } })).toBe(0);
    expect(await runSync({ targetDir: ".", strict: true, output, fetchImpl, sync: async () => report([{ tool: "host_x", change: "removed" }]) })).toBe(2);
    expect(await runSync({ targetDir: ".", output, fetchImpl, sync: async () => report([{ tool: "host_x", change: "removed" }]) })).toBe(0);
  });

  it("queries changed and breaking tools and prints per-tool impact", async () => {
    const messages = captureOutput();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [
        {
          tool: "host_x",
          apps: [{ id: "app_x", title: "X" }],
          automations: [{ id: "app_a", title: "A" }, { id: "app_b", title: "B" }],
          grants: 3,
        },
        { tool: "host_y", apps: [], automations: [], grants: 0 },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    await runSync({
      targetDir: ".",
      output: messages.output,
      url: "http://dev.test/api/vendo/",
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }], ["host_x", "host_y"]),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("http://dev.test/api/vendo/sync/impact", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ tools: ["host_x", "host_y"] }),
    });
    expect(messages.logs).toContain("impact: host_x breaks 2 automations, 1 app, 3 grants");
    expect(messages.logs).toContain("impact: host_y no saved references");
  });

  it("falls back when impact is unreachable and keeps strict exit two", async () => {
    const messages = captureOutput();
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); }) as typeof fetch;

    const exit = await runSync({
      targetDir: ".",
      strict: true,
      output: messages.output,
      url: "http://offline.test/api/vendo",
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    });

    expect(exit).toBe(2);
    expect(messages.logs).toContain("impact unknown — dev server not reachable at http://offline.test/api/vendo");
  });

  it("returns strict exit three when a breaking tool has nonzero impact", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [], automations: [{ id: "app_a", title: "A" }], grants: 0 }],
    }), { status: 200 })) as typeof fetch;

    await expect(runSync({
      targetDir: ".",
      strict: true,
      output: captureOutput().output,
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    })).resolves.toBe(3);
  });

  it("keeps strict exit two when breaking tools have zero impact", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [], automations: [], grants: 0 }],
    }), { status: 200 })) as typeof fetch;

    await expect(runSync({
      targetDir: ".",
      strict: true,
      output: captureOutput().output,
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    })).resolves.toBe(2);
  });

  it("does not query impact when there are no changed or breaking tools", async () => {
    const fetchImpl = vi.fn() as typeof fetch;

    await expect(runSync({
      targetDir: ".",
      strict: true,
      output: captureOutput().output,
      fetchImpl,
      sync: async () => report(),
    })).resolves.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pushes --report to the Cloud API with key auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));

    await expect(runSync({
      targetDir: ".",
      report: true,
      apiKey: "vnd_test",
      apiUrl: "https://cloud.test",
      fetchImpl,
      output: captureOutput().output,
      sync: async () => report(),
    })).resolves.toBe(0);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("https://cloud.test/api/v1/sync/report", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        accept: "application/json",
        authorization: "Bearer vnd_test",
        "content-type": "application/json",
      }),
      body: expect.any(String),
    }));
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({ report: report(), at: expect.any(String) });
  });

  it("warns for --report without a key and preserves the strict exit code", async () => {
    vi.stubEnv("VENDO_API_KEY", "");
    const messages = captureOutput();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [], automations: [], grants: 0 }],
    }), { status: 200 })) as typeof fetch;

    const exit = await runSync({
      targetDir: ".",
      strict: true,
      report: true,
      output: messages.output,
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    });

    expect(exit).toBe(2);
    expect(messages.errors).toContain("vendo sync: --report needs a Vendo Cloud key — run `vendo login`, set VENDO_API_KEY, or pass --key.");
  });

  // Self-serve audit B6: a keyless --report used to complain and exit 0, so a
  // CI reporting lane stayed green for as long as it never reported anything.
  it("a keyless --report is a failed run, not a note (exit 1)", async () => {
    vi.stubEnv("VENDO_API_KEY", "");
    const messages = captureOutput();
    const fetchImpl = vi.fn() as typeof fetch;

    const exit = await runSync({
      targetDir: ".",
      report: true,
      output: messages.output,
      fetchImpl,
      sync: async () => report(),
    });

    expect(exit).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(messages.errors).toContain("vendo sync: --report needs a Vendo Cloud key — run `vendo login`, set VENDO_API_KEY, or pass --key.");
  });

  it("warns when report push rejects and preserves blast-radius exit three", async () => {
    const messages = captureOutput();
    const push = vi.fn(async () => { throw new Error("cloud offline"); });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [{ id: "app_x", title: "X" }], automations: [], grants: 0 }],
    }), { status: 200 })) as typeof fetch;

    const exit = await runSync({
      targetDir: ".",
      strict: true,
      report: true,
      apiKey: "vnd_test",
      output: messages.output,
      fetchImpl,
      push,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    });

    expect(exit).toBe(3);
    expect(push).toHaveBeenCalledWith({ report: report([{ tool: "host_x", change: "removed" }]), impact: [
      { tool: "host_x", apps: [{ id: "app_x", title: "X" }], automations: [], grants: 0 },
    ], at: expect.any(String) });
    expect(messages.errors).toContain("warning: failed to push sync report: cloud offline");
  });

  it("prints every remixable wrapper error and exits two", async () => {
    const errors: string[] = [];
    const output = { log() {}, error(message: string) { errors.push(message); } };
    const failed = {
      ...report(),
      remixableErrors: [
        "src/app/page.tsx:4 \u2014 <Remixable> must wrap exactly one component element; extract it into a component and wrap that",
      ],
    };
    // An uncapturable wrapper is a defended constraint (final-shape spec
    // 2026-08-02): the sync run fails loudly, never degrades silently.
    expect(await runSync({ targetDir: ".", output, sync: async () => failed })).toBe(2);
    expect(errors.join("\n")).toContain("src/app/page.tsx:4");
    expect(errors.join("\n")).toContain("extract it into a component and wrap that");
  });

  it("keeps wrapper errors at exit two under --strict as well", async () => {
    const failed = {
      ...report(),
      remixableErrors: [
        "src/app/page.tsx:4 — <Remixable> must wrap exactly one component element; extract it into a component and wrap that",
      ],
    };
    // Exit 2 in ANY mode: --strict adds nothing here because the failure is
    // already hard — a wrapper the host marked remixable that cannot capture
    // means the remix silently would not exist.
    expect(await runSync({ targetDir: ".", strict: true, output: captureOutput().output, sync: async () => failed })).toBe(2);
  });

  it("prints one line per pruned stale baseline", async () => {
    const messages = captureOutput();
    const pruned = {
      ...report(),
      pins: { captured: [], drifted: [], pruned: ["MapleNetWorthCard", "CadenceMissingDocsHero"] },
    };
    expect(await runSync({ targetDir: ".", output: messages.output, sync: async () => pruned })).toBe(0);
    const prunedLines = messages.logs.filter((line) => line.startsWith("pruned:"));
    expect(prunedLines).toHaveLength(2);
    expect(prunedLines[0]).toContain("MapleNetWorthCard");
    expect(prunedLines[1]).toContain("CadenceMissingDocsHero");
    expect(prunedLines[0]).toContain("stale baseline deleted");
  });

  it("names drifted slots and says forks stay on the old capture until rebased", async () => {
    const messages = captureOutput();
    const drifted = {
      ...report(),
      pins: { captured: ["invoice-card"], drifted: ["net-worth-card"] },
    };
    expect(await runSync({ targetDir: ".", output: messages.output, sync: async () => drifted })).toBe(0);
    const log = messages.logs.join("\n");
    expect(log).toContain("pins: 1 captured, 1 drifted");
    expect(log).toContain("drifted: net-worth-card");
    expect(log).toContain("rebase");
    // Drift alone never fails the sync and never mutates any fork.
  });

  it("still pushes --report and keeps blast-radius exit three when wrappers also fail", async () => {
    const messages = captureOutput();
    const push = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [{ id: "app_x", title: "X" }], automations: [], grants: 0 }],
    }), { status: 200 })) as typeof fetch;
    const failed = {
      ...report([{ tool: "host_x", change: "removed" as const }]),
      remixableErrors: [
        "src/app/page.tsx:4 \u2014 <Remixable> must wrap exactly one component element; extract it into a component and wrap that",
      ],
    };

    const exit = await runSync({
      targetDir: ".",
      strict: true,
      report: true,
      apiKey: "vendo_key",
      output: messages.output,
      fetchImpl,
      push,
      sync: async () => failed,
    });

    // Wrapper errors never mask the more severe blast-radius signal, and the
    // pushed report still carries them for the Cloud console.
    expect(exit).toBe(3);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ report: failed }));
    expect(messages.errors.join("\n")).toContain("src/app/page.tsx:4");
  });

  it("prints the init-style catalog summary", async () => {
    const logs: string[] = [];
    expect(await runSync({ targetDir: ".", output: { log: (line) => logs.push(line), error() {} }, sync: async () => report() })).toBe(0);
    expect(logs).toContain("catalog.json: 2 discovered, 1 registered");
  });

  it("prints the schema coverage line, naming the blind tools", async () => {
    const logs: string[] = [];
    expect(await runSync({
      targetDir: ".",
      output: { log: (line) => logs.push(line), error() {} },
      sync: async () => report([], [], {
        total: 3,
        inputs: { known: 3, unknown: [] },
        outputs: { known: 1, unknown: ["host_a", "host_b"] },
      }),
    })).toBe(0);
    expect(logs.join("\n")).toContain("tool schemas: inputs 3/3 · outputs 1/3 — blind: host_a, host_b");
  });

  it("--json prints exactly one machine-readable object carrying report and impact", async () => {
    const messages = captureOutput();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [], automations: [{ id: "app_a", title: "A" }], grants: 0 }],
    }), { status: 200 })) as typeof fetch;

    const exit = await runSync({
      targetDir: ".",
      json: true,
      output: messages.output,
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }], ["host_x"]),
    });

    expect(exit).toBe(0);
    expect(messages.logs).toHaveLength(1);
    expect(messages.errors).toHaveLength(0);
    expect(JSON.parse(messages.logs[0]!)).toEqual({
      ok: true,
      exitCode: 0,
      report: report([{ tool: "host_x", change: "removed" }], ["host_x"]),
      impact: [{ tool: "host_x", apps: [], automations: [{ id: "app_a", title: "A" }], grants: 0 }],
      notes: ["judgment: skipped — this run cannot ask (pass `--ai` to judge non-interactively, `--no-ai` to say so explicitly)"],
      theme: null,
      baselines: null,
      components: null,
    });
  });

  it("--json carries wrapper errors in the report, exits two, and keeps stdout to one object", async () => {
    const messages = captureOutput();
    const failed = {
      ...report(),
      remixableErrors: [
        "src/app/page.tsx:4 — <Remixable> must wrap exactly one component element; extract it into a component and wrap that",
      ],
    };

    expect(await runSync({ targetDir: ".", json: true, output: messages.output, sync: async () => failed })).toBe(2);

    expect(messages.logs).toHaveLength(1);
    expect(messages.errors).toHaveLength(0);
    expect(JSON.parse(messages.logs[0]!)).toMatchObject({
      ok: false,
      exitCode: 2,
      report: { remixableErrors: [expect.stringContaining("src/app/page.tsx:4")] },
    });
  });

  it("--json keeps strict exit codes and surfaces unknown impact as null plus a note", async () => {
    const messages = captureOutput();
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); }) as typeof fetch;

    const exit = await runSync({
      targetDir: ".",
      strict: true,
      json: true,
      output: messages.output,
      url: "http://offline.test/api/vendo",
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    });

    expect(exit).toBe(2);
    expect(messages.logs).toHaveLength(1);
    expect(messages.errors).toHaveLength(0);
    expect(JSON.parse(messages.logs[0]!)).toMatchObject({
      ok: false,
      exitCode: 2,
      impact: null,
      notes: ["judgment: skipped — this run cannot ask (pass `--ai` to judge non-interactively, `--no-ai` to say so explicitly)", "impact unknown — dev server not reachable at http://offline.test/api/vendo"],
    });
  });

  it("--json reports an empty impact when nothing changed and collects report-push notes", async () => {
    vi.stubEnv("VENDO_API_KEY", "");
    const messages = captureOutput();
    const fetchImpl = vi.fn() as typeof fetch;

    const exit = await runSync({
      targetDir: ".",
      json: true,
      report: true,
      output: messages.output,
      fetchImpl,
      sync: async () => report(),
    });

    expect(exit).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(messages.errors).toHaveLength(0);
    expect(JSON.parse(messages.logs[0]!)).toMatchObject({
      ok: false,
      exitCode: 1,
      impact: [],
      notes: ["judgment: skipped — this run cannot ask (pass `--ai` to judge non-interactively, `--no-ai` to say so explicitly)", "vendo sync: --report needs a Vendo Cloud key — run `vendo login`, set VENDO_API_KEY, or pass --key."],
    });
  });

  it("--json emits a parseable envelope when extraction itself fails soft", async () => {
    const soft = captureOutput();
    expect(await runSync({
      targetDir: ".",
      json: true,
      output: soft.output,
      sync: async () => { throw new Error("scan"); },
    })).toBe(0);
    expect(soft.errors).toHaveLength(0);
    expect(JSON.parse(soft.logs[0]!)).toMatchObject({
      ok: true,
      exitCode: 0,
      impact: null,
      error: "sync failed soft: scan",
    });

    const strict = captureOutput();
    expect(await runSync({
      targetDir: ".",
      strict: true,
      json: true,
      output: strict.output,
      sync: async () => { throw new Error("scan"); },
    })).toBe(2);
    expect(JSON.parse(strict.logs[0]!)).toMatchObject({ ok: false, exitCode: 2, error: "sync failed soft: scan" });
  });
});

describe("sync telemetry", () => {
  it("tracks command_run sync with ok reflecting the exit code", async () => {
    const output = { log() {}, error() {} };
    const fetchImpl = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

    const ok = await telemetryCapture();
    expect(await runSync({ targetDir: ".", output, fetchImpl, sync: async () => report(), telemetry: ok.telemetry })).toBe(0);
    expect(ok.event("command_run").properties).toMatchObject({ command: "sync", ok: true });
    expect(typeof ok.event("command_run").properties.durationMs).toBe("number");

    const gated = await telemetryCapture();
    expect(await runSync({
      targetDir: ".",
      strict: true,
      output,
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
      telemetry: gated.telemetry,
    })).toBe(2);
    expect(gated.event("command_run").properties).toMatchObject({ command: "sync", ok: false });

    await rm(ok.home, { recursive: true, force: true });
    await rm(gated.home, { recursive: true, force: true });
  });
});

describe("telemetry project attribution + cloud-key sourcing (P1 review)", () => {
  const CLOUD_KEY = `vnd_${"0123456789abcdef".repeat(2)}01234567`; // vnd_ + 40 hex
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const quiet = { log() {}, error() {} };
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  async function target(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "vendo-sync-target-"));
    dirs.push(dir);
    return dir;
  }

  it("derives projectIdHash from the TARGET dir, not the shell cwd", async () => {
    const dir = await target();
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/target-app.git\n');
    expect(process.cwd()).not.toBe(dir);
    const tele = await telemetryCapture();
    dirs.push(tele.home);
    await runSync({ targetDir: dir, output: quiet, fetchImpl: offline, sync: async () => report(), telemetry: tele.telemetry });
    const expected = createHash("sha256").update(`${PROJECT_ID_SALT}github.com/acme/target-app`).digest("hex");
    expect(tele.event("command_run").properties.projectIdHash).toBe(expected);
  });

  it("activates the cloud lane from a VENDO_API_KEY in the target's .env.local", async () => {
    const dir = await target();
    await writeFile(join(dir, ".env.local"), `VENDO_API_KEY=${CLOUD_KEY}\n`);
    const tele = await telemetryCapture();
    dirs.push(tele.home);
    await runSync({ targetDir: dir, output: quiet, fetchImpl: offline, sync: async () => report(), telemetry: tele.telemetry });
    const props = tele.event("command_run").properties;
    expect(props.cloud).toBe(true);
    expect(props.cloudKeyHash).toBe(createHash("sha256").update(CLOUD_KEY).digest("hex"));
  });

  it("stays anonymous when the .env.local key is malformed", async () => {
    const dir = await target();
    await writeFile(join(dir, ".env.local"), "VENDO_API_KEY=vnd_not-a-real-key\n");
    const tele = await telemetryCapture();
    dirs.push(tele.home);
    await runSync({ targetDir: dir, output: quiet, fetchImpl: offline, sync: async () => report(), telemetry: tele.telemetry });
    const props = tele.event("command_run").properties;
    expect("cloud" in props).toBe(false);
    expect("cloudKeyHash" in props).toBe(false);
  });

  it("process-env consent still wins: DO_NOT_TRACK sends nothing despite an .env.local key", async () => {
    const dir = await target();
    await writeFile(join(dir, ".env.local"), `VENDO_API_KEY=${CLOUD_KEY}\n`);
    const tele = await telemetryCapture({ DO_NOT_TRACK: "1" });
    dirs.push(tele.home);
    await runSync({ targetDir: dir, output: quiet, fetchImpl: offline, sync: async () => report(), telemetry: tele.telemetry });
    expect(tele.events()).toEqual([]);
  });
});

describe("sync judgment-pass integration", () => {
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function hostWithTools(): Promise<{ dir: string; toolsPath: string; judgmentsPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), "vendo-sync-judge-"));
    dirs.push(dir);
    await mkdir(join(dir, ".vendo"), { recursive: true });
    const toolsPath = join(dir, ".vendo", "tools.json");
    await writeFile(toolsPath, `${JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_a",
        description: "Use this to call host_a.",
        inputSchema: { type: "object", properties: {} },
        risk: "read",
        binding: { kind: "route", method: "GET", path: "/api/a", argsIn: "query" },
        srcHash: "sha256:a",
      }],
    }, null, 2)}\n`, "utf8");
    return { dir, toolsPath, judgmentsPath: join(dir, ".vendo", "judgments.json") };
  }

  const reply = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

  /** Canned replies in order: the judge call, then the skeptic call. */
  function scripted(responses: string[]): { id: string; availability: () => Promise<string>; run: () => Promise<string> } {
    return {
      id: "scripted",
      availability: async () => "scripted engine",
      run: async () => {
        const next = responses.shift();
        if (next === undefined) throw new Error("scripted harness exhausted");
        return next;
      },
    };
  }

  /** A risk HARDENING plus prose — both apply themselves, so one run lands a
   *  judgment with no human in the loop. */
  const HARDENING = [
    reply({
      tools: [{
        name: "host_a",
        description: "Judged by the fake engine.",
        risk: "write",
        evidence: "await db.update(counter)",
      }],
      narrative: "host_a mutates a counter.",
    }),
    reply({ verdicts: [
      { name: "host_a", field: "description", verdict: "uphold" },
      { name: "host_a", field: "risk", verdict: "uphold" },
    ] }),
  ];

  it("keyless: structural-only line, zero errors, exit 0, files untouched — CI needs no model", async () => {
    const { dir, toolsPath, judgmentsPath } = await hostWithTools();
    const before = await readFile(toolsPath, "utf8");
    const messages = captureOutput();
    const exit = await runSync({
      targetDir: dir,
      output: messages.output,
      fetchImpl: offline,
      sync: async () => report(),
      ai: true,
      judge: {
        resolveCredential: async () => ({ rung: "none" }),
        // proof, not inference: ANY engine touchpoint (even the availability
        // probe) throws and fails this test outright
        harnesses: [{
          id: "forbidden",
          availability: async () => { throw new Error("keyless sync must never probe an engine"); },
          run: async () => { throw new Error("keyless sync must never invoke a model"); },
        }],
      },
    });
    expect(exit).toBe(0);
    expect(messages.errors.filter((line) => !line.startsWith("warning:"))).toEqual([]);
    expect(messages.logs.join("\n")).toContain("judgment: structural-only");
    expect(await readFile(toolsPath, "utf8")).toBe(before);
    // A keyless pass records nothing: no empty judgments file appears.
    await expect(readFile(judgmentsPath, "utf8")).rejects.toThrow();
  });

  it("keyed: writes the surviving judgment to judgments.json and prints the narrative", async () => {
    const { dir, toolsPath, judgmentsPath } = await hostWithTools();
    const beforeTools = await readFile(toolsPath, "utf8");
    const messages = captureOutput();
    const exit = await runSync({
      targetDir: dir,
      output: messages.output,
      fetchImpl: offline,
      sync: async () => report(),
      ai: true,
      judge: { harness: scripted([...HARDENING]) },
    });
    expect(exit).toBe(0);
    const file = JSON.parse(await readFile(judgmentsPath, "utf8"));
    expect(file.tools.host_a).toMatchObject({
      binding: "GET /api/a",
      fields: { description: "Judged by the fake engine.", risk: "write" },
      evidence: "await db.update(counter)",
    });
    // The judgment channel NEVER writes the deterministic skeleton.
    expect(await readFile(toolsPath, "utf8")).toBe(beforeTools);
    expect(messages.logs.join("\n")).toContain("host_a mutates a counter.");
    expect(messages.logs.join("\n")).toContain("1 tools judged");
  });

  it("--no-ai skips the pass entirely and leaves .vendo untouched", async () => {
    const { dir, toolsPath, judgmentsPath } = await hostWithTools();
    const before = await readFile(toolsPath, "utf8");
    const messages = captureOutput();
    const syncSeam = vi.fn(async () => report());
    const exit = await runSync({
      targetDir: dir,
      output: messages.output,
      fetchImpl: offline,
      sync: syncSeam as never,
      ai: false,
      judge: {
        harness: {
          id: "never",
          availability: async () => { throw new Error("must not probe"); },
          run: async () => { throw new Error("must not run"); },
        },
      },
    });
    expect(exit).toBe(0);
    expect(syncSeam).toHaveBeenCalled();
    expect(messages.logs.join("\n")).not.toContain("judgment");
    expect(await readFile(toolsPath, "utf8")).toBe(before);
    await expect(readFile(judgmentsPath, "utf8")).rejects.toThrow();
  });

  it("--review asks before a loosening lands; declining drops it and keeps the hardening", async () => {
    const { dir, toolsPath, judgmentsPath } = await hostWithTools();
    // Waking a scanner-disabled tool is the clearest loosening there is.
    await writeFile(toolsPath, `${JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_a",
        description: "Use this to call host_a.",
        inputSchema: { type: "object", properties: {} },
        risk: "read",
        disabled: true,
        binding: { kind: "route", method: "GET", path: "/api/a", argsIn: "query" },
        srcHash: "sha256:a",
      }],
    }, null, 2)}\n`, "utf8");
    const messages = captureOutput();
    const questions: string[] = [];
    const exit = await runSync({
      targetDir: dir,
      output: messages.output,
      fetchImpl: offline,
      sync: async () => report(),
      review: true,
      ai: true,
      judge: {
        harness: scripted([
          reply({
            tools: [{
              name: "host_a",
              description: "Reads the counter.",
              disabled: false,
              evidence: "export async function GET() {",
            }],
            narrative: "",
          }),
          reply({ verdicts: [
            { name: "host_a", field: "description", verdict: "uphold" },
            { name: "host_a", field: "disabled", verdict: "uphold" },
          ] }),
        ]),
        confirm: async (question) => { questions.push(question); return false; },
      },
    });
    expect(exit).toBe(0);
    expect(questions.join("\n")).toContain("judgments.json");
    expect(messages.logs.join("\n")).toContain("loosenings declined and dropped");
    const file = JSON.parse(await readFile(judgmentsPath, "utf8"));
    // The prose hardening applied itself; the wake did not land.
    expect(file.tools.host_a.fields.description).toBe("Reads the counter.");
    expect(file.tools.host_a.fields.disabled).toBeUndefined();
  });

  it("resolves a model key that lives only in the sync dir's .env.local (#567)", async () => {
    // The ONLY credential lives in the project's .env.local, exactly the case
    // that previously fell through to structural-only. A sentinel var name
    // keeps the assertion deterministic no matter what real ANTHROPIC_API_KEY /
    // VENDO_API_KEY the developer/CI machine exports (which, with process env
    // winning, would otherwise mask the .env.local value under test).
    const { dir, judgmentsPath } = await hostWithTools();
    await writeFile(join(dir, ".env.local"), "VENDO_TEST_ONLY_MODEL_KEY=sk-only-in-dotenv\n", "utf8");
    const messages = captureOutput();
    let seenKey: string | undefined;
    const responses = [...HARDENING];
    const exit = await runSync({
      targetDir: dir,
      output: messages.output,
      fetchImpl: offline,
      sync: async () => report(),
      ai: true,
      judge: {
        harnesses: [{
          id: "npx-engine",
          availability: async ({ env }: { env: Record<string, string | undefined> }) =>
            (typeof env.VENDO_TEST_ONLY_MODEL_KEY === "string" ? "byo (.env.local)" : null),
          run: async () => {
            const next = responses.shift();
            if (next === undefined) throw new Error("scripted harness exhausted");
            return next;
          },
        }],
        resolveCredential: async ({ env }) => {
          seenKey = env.VENDO_TEST_ONLY_MODEL_KEY;
          return typeof env.VENDO_TEST_ONLY_MODEL_KEY === "string"
            ? { rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }
            : { rung: "none" };
        },
      },
    });
    expect(exit).toBe(0);
    expect(seenKey).toBe("sk-only-in-dotenv");
    const file = JSON.parse(await readFile(judgmentsPath, "utf8"));
    expect(file.tools.host_a).toMatchObject({ fields: { description: "Judged by the fake engine." } });
  });

  it("no key in .env.local and none in process env stays structural-only (#567)", async () => {
    // Sentinel var that only a .env.local could carry — kept out of process
    // env so the "neither present" branch is deterministic regardless of the
    // developer/CI machine's real ANTHROPIC_API_KEY / VENDO_API_KEY.
    const { dir, toolsPath } = await hostWithTools();
    const before = await readFile(toolsPath, "utf8");
    const messages = captureOutput();
    const exit = await runSync({
      targetDir: dir,
      output: messages.output,
      fetchImpl: offline,
      sync: async () => report(),
      ai: true,
      judge: {
        harnesses: [{
          id: "npx-engine",
          availability: async ({ env }: { env: Record<string, string | undefined> }) =>
            (typeof env.VENDO_TEST_ONLY_MODEL_KEY === "string" ? "byo" : null),
          run: async () => { throw new Error("must not run without a key"); },
        }],
        resolveCredential: async ({ env }) =>
          (typeof env.VENDO_TEST_ONLY_MODEL_KEY === "string"
            ? { rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }
            : { rung: "none" }),
      },
    });
    expect(exit).toBe(0);
    expect(messages.logs.join("\n")).toContain("judgment: structural-only");
    expect(await readFile(toolsPath, "utf8")).toBe(before);
  });

  it("--json folds judgment lines into notes, never stdout prose", async () => {
    const { dir } = await hostWithTools();
    const messages = captureOutput();
    const exit = await runSync({
      targetDir: dir,
      output: messages.output,
      fetchImpl: offline,
      json: true,
      sync: async () => report(),
      ai: true,
      judge: { resolveCredential: async () => ({ rung: "none" }) },
    });
    expect(exit).toBe(0);
    // Exactly one object on stdout: the pass's narrative never leaks as prose.
    expect(messages.logs).toHaveLength(1);
    const result = JSON.parse(messages.logs[0]!);
    expect(result.notes.join("\n")).toContain("judgment: structural-only");
  });
});

/**
 * What the `vendo sync` WRAPPER owns, now that the flow itself lives in
 * sync-flow.ts (and is tested there): who counts as interactive, and the
 * one-object stdout contract.
 */
describe("vendo sync wrapper coherence", () => {
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const REPORT = {
    tools: { added: [], removed: [], changed: [] },
    breaking: [],
    toolSchemas: { total: 0, inputs: { known: 0, unknown: [] }, outputs: { known: 0, unknown: [] } },
    pins: { captured: [], drifted: [] },
    remixableErrors: [],
    catalog: { discovered: 0, registered: 0 },
    components: { captured: [], drifted: [] },
    warnings: [],
  };
  const scan = async () => REPORT;

  async function host(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "vendo-sync-coherence-"));
    dirs.push(dir);
    await mkdir(join(dir, ".vendo"), { recursive: true });
    return dir;
  }

  /** A harness that fails loudly if the judgment pass so much as probes it. */
  const forbidden = {
    id: "never",
    availability: async () => { throw new Error("the judgment pass must not run here"); },
    run: async () => { throw new Error("the judgment pass must not run here"); },
  };

  // I1 (review): existing installs have a bare `predev: vendo sync`. npm
  // inherits the terminal, so without this exemption `npm run dev` blocks on a
  // default-yes prompt and a reflexive Enter starts spending.
  it("a package-script run is never interactive, even with a TTY", async () => {
    vi.stubEnv("npm_lifecycle_event", "predev");
    // A REAL TTY, or the assertion is vacuous: this is exactly the shape
    // `npm run dev` hands its predev hook.
    const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY };
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    const messages = captureOutput();
    expect(await runSync({
      targetDir: await host(),
      output: messages.output,
      fetchImpl: offline,
      sync: scan,
      judge: {
        harnesses: [forbidden],
        confirm: async () => { throw new Error("prompted inside an npm lifecycle hook"); },
      },
    }).finally(() => {
      process.stdin.isTTY = tty.in;
      process.stdout.isTTY = tty.out;
    })).toBe(0);
    expect(messages.logs.join("\n")).toContain("judgment: skipped — this run cannot ask");
  });

  describe("--yes and --json are non-interactive by construction", () => {
    it("neither ever prompts", async () => {
      for (const flags of [{ yes: true }, { json: true }] as const) {
        const messages = captureOutput();
        expect(await runSync({
          targetDir: await host(),
          output: messages.output,
          fetchImpl: offline,
          sync: scan,
          ...flags,
          judge: {
            harnesses: [forbidden],
            confirm: async () => { throw new Error("prompted") },
          },
        })).toBe(0);
      }
    });

    it("--json still emits exactly one object", async () => {
      const messages = captureOutput();
      expect(await runSync({
        targetDir: await host(),
        output: messages.output,
        fetchImpl: offline,
        sync: scan,
        json: true,
        judge: { harnesses: [forbidden], confirm: async () => { throw new Error("prompted") } },
      })).toBe(0);
      expect(messages.logs).toHaveLength(1);
      const result = JSON.parse(messages.logs[0]!) as { theme: unknown; baselines: unknown };
      expect(result.theme).toBeNull();
      expect(result.baselines).toBeNull();
    });
  });
});

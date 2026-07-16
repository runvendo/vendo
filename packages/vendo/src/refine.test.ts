import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDO_TOOLS_FORMAT, VENDO_CAPABILITIES_FORMAT, VENDO_OVERRIDES_FORMAT } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRefine, type RefineProposals } from "./refine.js";

// The refine engine (ENG-250, extraction spec §3): deterministic tests with a
// mocked BYO model. The engine's own guarantees under test: model-declared
// risk is never trusted, tools.json is never a change target, invalid
// proposals are dropped with reasons, and probes gate what is offered.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TOOLS_FILE = {
  format: VENDO_TOOLS_FORMAT,
  tools: [
    {
      name: "host_listTasks",
      description: "List tasks",
      inputSchema: { type: "object" },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/tasks", argsIn: "query" },
    },
    {
      name: "host_completeTask",
      description: "Complete a task",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      risk: "write",
      binding: { kind: "openapi", operationId: "completeTask", method: "POST", path: "/api/tasks/{id}/complete" },
    },
    {
      name: "host_deleteTask",
      description: "Delete a task",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      risk: "destructive",
      binding: { kind: "openapi", operationId: "deleteTask", method: "DELETE", path: "/api/tasks/{id}" },
    },
    {
      name: "host_debugDump",
      description: "Dump internal state",
      inputSchema: { type: "object" },
      risk: "read",
      disabled: true,
      binding: { kind: "route", method: "GET", path: "/api/debug", argsIn: "query" },
    },
  ],
} as const;

async function makeRoot(extra: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-refine-"));
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, ".vendo"), { recursive: true });
  await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify(TOOLS_FILE));
  await writeFile(join(root, ".vendo", "brief.md"), "Relay is a tiny team task tracker.\n");
  for (const [path, content] of Object.entries(extra)) {
    await mkdir(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(root, ...path.split("/")), content);
  }
  return root;
}

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

/** A mock BYO model whose single generateObject call returns `proposals`. */
function proposalModel(proposals: RefineProposals): LanguageModel & { prompts: string[] } {
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (request) => {
      const last = request.prompt[request.prompt.length - 1];
      const content = last !== undefined && Array.isArray(last.content) ? last.content : [];
      const text = content
        .filter((part): part is { type: "text"; text: string } => (part as { type: string }).type === "text")
        .map((part) => part.text)
        .join("");
      prompts.push(text);
      return {
        content: [{ type: "text", text: JSON.stringify(proposals) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: ZERO_USAGE,
        warnings: [],
      };
    },
  }) as LanguageModel & { prompts: string[] };
  (model as { prompts: string[] }).prompts = prompts;
  return model;
}

const completeAllOpen = {
  name: "host_complete_open_tasks",
  description: "Complete every open task in one ask",
  inputSchema: { type: "object" },
  steps: [
    { id: "list", tool: "host_listTasks", args: { status: "'open'" } },
    { id: "complete", tool: "host_completeTask", forEach: "steps.list.id", args: { id: "item" } },
  ],
};

describe("runRefine — proposals become reviewable diffs", () => {
  it("proposes a compound into capabilities.json with risk computed as the max of step risks", async () => {
    const root = await makeRoot();
    const result = await runRefine({ root, model: proposalModel({ compounds: [completeAllOpen] }) });

    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;
    expect(change.path).toBe(".vendo/capabilities.json");
    expect(change.before).toBeNull();
    const file = JSON.parse(change.after) as { format: string; tools: Array<Record<string, unknown>> };
    expect(file.format).toBe(VENDO_CAPABILITIES_FORMAT);
    expect(file.tools).toHaveLength(1);
    const compound = file.tools[0]!;
    expect(compound.name).toBe("host_complete_open_tasks");
    // read + write steps → write, computed by the engine (04 §6), never model-declared.
    expect(compound.risk).toBe("write");
    expect(compound.note).toBe("authored by vendo refine");
    expect((compound.binding as { kind: string }).kind).toBe("compound");
    expect(change.diff).toContain("+++ b/.vendo/capabilities.json");
  });

  it("never offers tools.json as a change target", async () => {
    const root = await makeRoot();
    const result = await runRefine({
      root,
      model: proposalModel({
        compounds: [completeAllOpen],
        riskCorrections: [{ tool: "host_listTasks", risk: "write" }],
        briefUpdate: "A better brief.",
      }),
    });
    expect(result.changes.map((change) => change.path)).not.toContain(".vendo/tools.json");
    expect(result.changes.map((change) => change.path).sort()).toEqual([
      ".vendo/brief.md",
      ".vendo/capabilities.json",
      ".vendo/overrides.json",
    ]);
  });

  it("drops invalid compounds with reasons: unknown step tools, disabled step tools, name collisions, bad names", async () => {
    const root = await makeRoot();
    const result = await runRefine({
      root,
      model: proposalModel({
        compounds: [
          { ...completeAllOpen, name: "host_listTasks" },
          { ...completeAllOpen, name: "bad name!" },
          {
            name: "host_uses_unknown",
            description: "references a tool that does not exist",
            steps: [{ id: "one", tool: "host_nope" }],
          },
          {
            name: "host_uses_disabled",
            description: "references a disabled tool",
            steps: [{ id: "one", tool: "host_debugDump" }],
          },
          {
            name: "host_dupe_ids",
            description: "duplicate step ids",
            steps: [{ id: "same", tool: "host_listTasks" }, { id: "same", tool: "host_listTasks" }],
          },
        ],
      }),
    });
    expect(result.changes).toHaveLength(0);
    const reasons = Object.fromEntries(result.dropped.map((drop) => [drop.target, drop.reason]));
    expect(reasons["host_listTasks"]).toContain("collides with an extracted tool");
    expect(reasons["bad name!"]).toContain("does not match");
    expect(reasons["host_uses_unknown"]).toContain("unknown tool");
    expect(reasons["host_uses_disabled"]).toContain("disabled tool");
    expect(reasons["host_dupe_ids"]).toContain("unique");
  });

  it("compound steps may not reference other proposed compounds", async () => {
    const root = await makeRoot();
    const result = await runRefine({
      root,
      model: proposalModel({
        compounds: [
          completeAllOpen,
          {
            name: "host_nested",
            description: "a compound of a compound",
            steps: [{ id: "inner", tool: "host_complete_open_tasks" }],
          },
        ],
      }),
    });
    const file = JSON.parse(result.changes[0]!.after) as { tools: Array<{ name: string }> };
    expect(file.tools.map((tool) => tool.name)).toEqual(["host_complete_open_tasks"]);
    expect(result.dropped.some((drop) => drop.target === "host_nested")).toBe(true);
  });

  it("appends to an existing capabilities.json without disturbing prior entries", async () => {
    const existing = {
      format: VENDO_CAPABILITIES_FORMAT,
      tools: [{
        name: "host_existing_flow",
        description: "existing",
        inputSchema: { type: "object" },
        risk: "read",
        binding: { kind: "compound", steps: [{ id: "list", tool: "host_listTasks" }] },
      }],
      briefs: [{ name: "old-brief", text: "keep me" }],
    };
    const root = await makeRoot({ ".vendo/capabilities.json": JSON.stringify(existing) });
    const result = await runRefine({
      root,
      model: proposalModel({
        compounds: [completeAllOpen, { ...completeAllOpen, name: "host_existing_flow" }],
        briefs: [{ name: "bulk-complete", text: "Use host_complete_open_tasks for sweeps", tools: ["host_completeTask"] }],
      }),
    });
    const file = JSON.parse(result.changes[0]!.after) as {
      tools: Array<{ name: string }>;
      briefs: Array<{ name: string }>;
    };
    expect(file.tools.map((tool) => tool.name)).toEqual(["host_existing_flow", "host_complete_open_tasks"]);
    expect(file.briefs.map((brief) => brief.name)).toEqual(["old-brief", "bulk-complete"]);
    expect(result.dropped.some((drop) => drop.target === "host_existing_flow" && drop.reason.includes("existing compound"))).toBe(true);
  });

  it("keeps only output tools in brief references — a dropped compound is never referenced", async () => {
    const root = await makeRoot();
    const result = await runRefine({
      root,
      model: proposalModel({
        compounds: [
          completeAllOpen,
          { name: "host_dropped", description: "dropped: unknown step", steps: [{ id: "one", tool: "host_nope" }] },
        ],
        briefs: [{
          name: "sweep",
          text: "Use the compound to sweep tasks.",
          // References a surviving compound, a real primitive, the dropped
          // compound, and a bogus name — only the first two may survive.
          tools: ["host_complete_open_tasks", "host_listTasks", "host_dropped", "host_bogus"],
        }],
      }),
    });
    const file = JSON.parse(result.changes[0]!.after) as { briefs: Array<{ name: string; tools?: string[] }> };
    expect(file.briefs[0]!.tools).toEqual(["host_complete_open_tasks", "host_listTasks"]);
    expect(result.dropped.some((drop) => drop.target === "host_dropped")).toBe(true);
  });

  it("merges risk corrections, curation, and description improvements into overrides.json field-wise", async () => {
    const existingOverrides = {
      format: VENDO_OVERRIDES_FORMAT,
      tools: { host_deleteTask: { critical: true } },
      remix: { ignoreSlots: [] },
    };
    const root = await makeRoot({ ".vendo/overrides.json": JSON.stringify(existingOverrides) });
    const result = await runRefine({
      root,
      model: proposalModel({
        riskCorrections: [
          { tool: "host_listTasks", risk: "write", reason: "list mutates a view counter" },
          { tool: "host_deleteTask", risk: "write", reason: "soft delete only" },
          { tool: "host_unknown", risk: "read" },
        ],
        curation: [{ tool: "host_debugDump", disabled: false, reason: "useful" }],
        descriptions: [{ tool: "host_completeTask", description: "Mark a Relay task as done by id" }],
      }),
    });
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;
    expect(change.path).toBe(".vendo/overrides.json");
    const file = JSON.parse(change.after) as {
      format: string;
      tools: Record<string, Record<string, unknown>>;
      remix: unknown;
    };
    expect(file.format).toBe(VENDO_OVERRIDES_FORMAT);
    // Existing hand-written fields survive; refine's fields merge in.
    expect(file.tools["host_deleteTask"]).toEqual({ critical: true, risk: "write" });
    expect(file.tools["host_listTasks"]).toEqual({ risk: "write" });
    expect(file.tools["host_debugDump"]).toEqual({ disabled: false });
    expect(file.tools["host_completeTask"]).toEqual({ description: "Mark a Relay task as done by id" });
    expect(file.remix).toEqual({ ignoreSlots: [] });
    // The destructive → write downgrade and the re-enable both carry warnings.
    expect(change.warnings.some((warning) => warning.includes("DOWNGRADE") && warning.includes("host_deleteTask"))).toBe(true);
    expect(change.warnings.some((warning) => warning.includes("re-ENABLE") && warning.includes("host_debugDump"))).toBe(true);
    expect(result.dropped.some((drop) => drop.target === "host_unknown")).toBe(true);
  });

  it("offers brief.md updates and drops unchanged ones", async () => {
    const root = await makeRoot();
    const updated = await runRefine({
      root,
      model: proposalModel({ briefUpdate: "Relay tracks a product team's tasks; the agent sweeps and summarizes them." }),
    });
    expect(updated.changes).toHaveLength(1);
    expect(updated.changes[0]!.path).toBe(".vendo/brief.md");
    expect(updated.changes[0]!.after.endsWith("\n")).toBe(true);

    const unchanged = await runRefine({
      root,
      model: proposalModel({ briefUpdate: "Relay is a tiny team task tracker." }),
    });
    expect(unchanged.changes).toHaveLength(0);
    expect(unchanged.dropped.some((drop) => drop.kind === "brief-update")).toBe(true);
  });

  it("returns no changes when the model proposes nothing", async () => {
    const root = await makeRoot();
    const result = await runRefine({ root, model: proposalModel({}) });
    expect(result.changes).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  it("requires .vendo/tools.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-refine-empty-"));
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }); });
    await expect(runRefine({ root, model: proposalModel({}) })).rejects.toThrow(/vendo init/);
  });
});

describe("runRefine — inputs reach the model", () => {
  it("feeds the miss feed, interview answers, and bounded source context into the proposal prompt", async () => {
    const miss = {
      format: "vendo/capability-miss@1",
      id: "mis_1",
      at: "2026-07-15T00:00:00.000Z",
      hostId: "host_1",
      sessionId: "session_1",
      intent: "complete every overdue task at once",
      surface: { format: "vendo/tools@1", hash: `sha256:${"0".repeat(64)}` },
      trigger: { kind: "no-matching-tool", toolsConsidered: ["host_completeTask"] },
    };
    const root = await makeRoot({
      ".vendo/data/misses.jsonl": `${JSON.stringify(miss)}\nnot json\n`,
      "src/server/tasks.ts": "export function bulkComplete() { /* UI-only orchestration */ }",
    });
    const model = proposalModel({});
    await runRefine({ root, model, interview: ["users want a weekly sweep"] });

    expect(model.prompts).toHaveLength(1);
    const prompt = JSON.parse(model.prompts[0]!) as {
      capabilityMisses: Array<{ intent: string; trigger: string }>;
      interview: string[];
      sourceTree: string[];
      sourceFiles: Array<{ path: string }>;
      tools: Array<{ name: string; risk: string; disabled: boolean }>;
    };
    expect(prompt.capabilityMisses).toEqual([{ intent: "complete every overdue task at once", trigger: "no-matching-tool" }]);
    expect(prompt.interview).toEqual(["users want a weekly sweep"]);
    expect(prompt.sourceTree).toContain("src/server/tasks.ts");
    expect(prompt.sourceFiles.some((file) => file.path === "src/server/tasks.ts")).toBe(true);
    expect(prompt.tools.find((tool) => tool.name === "host_debugDump")?.disabled).toBe(true);
  });
});

describe("runRefine — probe against the running dev app", () => {
  const fetchFor = (routes: Record<string, number>): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(typeof input === "string" ? input : (input as URL | Request) instanceof URL ? String(input) : (input as Request).url);
      if (url.pathname.endsWith("/status")) {
        return new Response(JSON.stringify({ posture: "ok", version: "test", blocks: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const status = routes[url.pathname];
      if (status === undefined) return new Response("{}", { status: 404 });
      return new Response("{}", { status });
    }) as typeof fetch;

  it("verifies a compound whose read step answers live; write steps are never executed", async () => {
    const root = await makeRoot();
    const calls: string[] = [];
    const fetchImpl: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      return fetchFor({ "/api/tasks": 200 })(input, init);
    }) as typeof fetch;

    const result = await runRefine({
      root,
      model: proposalModel({ compounds: [completeAllOpen] }),
      url: "http://127.0.0.1:9999/api/vendo",
      fetchImpl,
    });

    expect(result.probes).toHaveLength(1);
    const probe = result.probes[0]!;
    expect(probe.status).toBe("verified");
    expect(probe.checks.some((check) => check.name === "dev-app" && check.ok)).toBe(true);
    expect(probe.checks.some((check) => check.detail.includes("GET /api/tasks → 200"))).toBe(true);
    // The write step was validated statically, not executed.
    expect(probe.checks.some((check) => check.name.includes("host_completeTask") && check.detail.includes("not executed"))).toBe(true);
    expect(calls).not.toContain("POST /api/tasks/{id}/complete");
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(0);
    expect(result.changes).toHaveLength(1);
  });

  it("drops a compound whose read step 404s against the dev app", async () => {
    const root = await makeRoot();
    const result = await runRefine({
      root,
      model: proposalModel({ compounds: [completeAllOpen] }),
      url: "http://127.0.0.1:9999/api/vendo",
      fetchImpl: fetchFor({ "/api/tasks": 404 }),
    });
    expect(result.probes[0]!.status).toBe("failed");
    expect(result.changes).toHaveLength(0);
    expect(result.dropped.some((drop) => drop.target === "host_complete_open_tasks" && drop.reason.includes("probe failed"))).toBe(true);
  });

  it("degrades to static-only when the dev app is unreachable — proposals are still offered", async () => {
    const root = await makeRoot();
    const result = await runRefine({
      root,
      model: proposalModel({ compounds: [completeAllOpen] }),
      url: "http://127.0.0.1:1/api/vendo",
      fetchImpl: (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch,
    });
    expect(result.probes[0]!.status).toBe("static-only");
    expect(result.probes[0]!.checks.some((check) => check.name === "dev-app" && !check.ok)).toBe(true);
    expect(result.changes).toHaveLength(1);
  });

  it("auth-gated (401) read steps count as reachable", async () => {
    const root = await makeRoot();
    const result = await runRefine({
      root,
      model: proposalModel({ compounds: [completeAllOpen] }),
      url: "http://127.0.0.1:9999/api/vendo",
      fetchImpl: fetchFor({ "/api/tasks": 401 }),
    });
    expect(result.probes[0]!.status).toBe("verified");
    expect(result.probes[0]!.checks.some((check) => check.detail.includes("auth-gated"))).toBe(true);
  });
});

describe("runRefine — the cloud-seam transcript", () => {
  it("records inputs, raw proposals, probes, and drops", async () => {
    const root = await makeRoot();
    const result = await runRefine({
      root,
      model: proposalModel({ compounds: [completeAllOpen] }),
      interview: ["bulk sweeps"],
    });
    const transcript = result.transcript;
    expect(transcript.version).toBe(0);
    expect(transcript.inputs.tools).toBe(4);
    expect(transcript.inputs.interview).toEqual(["bulk sweeps"]);
    expect((transcript.proposals.compounds ?? [])[0]?.name).toBe("host_complete_open_tasks");
    expect(transcript.probes).toHaveLength(1);
    expect(transcript.decisions).toEqual([]);
  });
});

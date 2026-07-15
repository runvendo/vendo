import { describe, expect, it, vi } from "vitest";
import type { PermissionGrant, RunContext, ToolCall, ToolOutcome, ToolRegistry } from "@vendoai/core";
import { VENDO_CAPABILITIES_FORMAT, VENDO_OVERRIDES_FORMAT, VENDO_TOOLS_FORMAT } from "@vendoai/core";
import type { CapabilitiesFile, CompoundTool, ExtractedTool } from "../formats.js";
import { createActions, type ActionsRunContext } from "../runtime/registry.js";
import { createCompoundExecutor } from "../runtime/compound.js";

// Red-team suite for compound tools (04-actions §6). The whole design is ONE
// invariant: a compound has NO execution capability of its own. Every real
// call is a step routed through the umbrella-wired `invokeTool` seam (the
// guard binding); absent that seam, absent registration, or absent a valid
// primitive target, a compound performs NO work. Each test here asserts the
// negative space — what must NOT happen. The guard-visible counterparts
// (per-step approvals/grants/breakers/audit through a real guard) live in
// packages/vendo/src/compound.e2e.test.ts, where guard may be imported.

const present: RunContext = {
  principal: { kind: "user", subject: "user_1" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
};

const routeTool = (name: string, extras: Partial<ExtractedTool> = {}): ExtractedTool => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  risk: "read",
  binding: { kind: "route", method: "GET", path: "/probe", argsIn: "query" },
  ...extras,
});

const compound = (name: string, steps: CompoundTool["binding"]["steps"], extras: Partial<CompoundTool> = {}): CompoundTool => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  risk: "read",
  binding: { kind: "compound", steps },
  ...extras,
});

const capabilities = (tools: CompoundTool[]): CapabilitiesFile => ({ format: VENDO_CAPABILITIES_FORMAT, tools });

const call = (tool: string, args: unknown = {}): ToolCall => ({ id: "call_atk_1", tool, args });

describe("no work without the guard seam", () => {
  it("a valid compound with NO invokeTool performs zero fetches and zero connector calls", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    const connectorExecute = vi.fn(async (): Promise<ToolOutcome> => ({ status: "ok", output: null }));
    const actions = createActions({
      tools: [routeTool("host_read"), routeTool("host_write", { risk: "write" })],
      connectors: [{
        name: "stub",
        descriptors: async () => [{ name: "ext_send", description: "x", inputSchema: {}, risk: "write" }],
        execute: connectorExecute,
      }],
      baseUrl: "http://host.test",
      fetch: fetchSpy as unknown as typeof fetch,
      capabilities: capabilities([
        compound("host_flow", [
          { id: "a", tool: "host_read" },
          { id: "b", tool: "host_write" },
          { id: "c", tool: "ext_send" },
        ], { risk: "write" }),
      ]),
    });

    const outcome = await actions.execute(call("host_flow"), present);

    expect(outcome).toMatchObject({ status: "error", error: { code: "not-implemented" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectorExecute).not.toHaveBeenCalled();
  });

  it("the walker never reaches executeHost or connectors directly: with a seam, all step work goes through it", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    const seamCalls: ToolCall[] = [];
    const invokeTool: ToolRegistry["execute"] = async (stepCall) => {
      seamCalls.push(stepCall);
      return { status: "ok", output: null };
    };
    const actions = createActions({
      tools: [routeTool("host_read"), routeTool("host_write", { risk: "write" })],
      baseUrl: "http://host.test",
      fetch: fetchSpy as unknown as typeof fetch,
      capabilities: capabilities([
        compound("host_flow", [{ id: "a", tool: "host_read" }, { id: "b", tool: "host_write" }], { risk: "write" }),
      ]),
      invokeTool,
    });

    const outcome = await actions.execute(call("host_flow"), present);

    expect(outcome).toMatchObject({ status: "ok" });
    // The no-unguarded-path theorem at the actions layer: the registry's own
    // fetch was NEVER touched by the walk — every real call crossed the seam.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seamCalls.map((stepCall) => stepCall.tool)).toEqual(["host_read", "host_write"]);
  });
});

describe("a compound cannot reach what the host disabled or never registered", () => {
  it("a quarantined compound (disabled step tool) is not-found and performs no work", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchSpy = vi.fn(async () => new Response("{}"));
    const seam = vi.fn(async (): Promise<ToolOutcome> => ({ status: "ok", output: null }));
    const actions = createActions({
      tools: [routeTool("host_read")],
      capabilities: capabilities([compound("host_flow", [{ id: "a", tool: "host_read" }])]),
      baseUrl: "http://host.test",
      fetch: fetchSpy as unknown as typeof fetch,
      invokeTool: seam,
    });
    // Sanity: without the disable, the compound exists.
    expect((await actions.descriptors()).map((descriptor) => descriptor.name)).toContain("host_flow");

    const disabledActions = createActions({
      tools: [routeTool("host_read", { disabled: true })],
      capabilities: capabilities([compound("host_flow", [{ id: "a", tool: "host_read" }])]),
      baseUrl: "http://host.test",
      fetch: fetchSpy as unknown as typeof fetch,
      invokeTool: seam,
    });

    expect((await disabledActions.descriptors()).map((descriptor) => descriptor.name)).not.toContain("host_flow");
    const outcome = await disabledActions.execute(call("host_flow"), present);
    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seam).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("risk cannot understate the steps: the compound is quarantined, not weakened", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seam = vi.fn(async (): Promise<ToolOutcome> => ({ status: "ok", output: null }));
    const actions = createActions({
      tools: [routeTool("host_destroy", { risk: "destructive" })],
      // An agent-authored file claims "read" for a destructive walk.
      capabilities: capabilities([compound("host_flow", [{ id: "a", tool: "host_destroy" }], { risk: "read" })]),
      invokeTool: seam,
    });
    expect((await actions.descriptors()).map((descriptor) => descriptor.name)).not.toContain("host_flow");
    expect(await actions.execute(call("host_flow"), present)).toMatchObject({
      status: "error",
      error: { code: "not-found" },
    });
    expect(seam).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("an override that disables a step tool after authoring quarantines the compound at next load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seam = vi.fn(async (): Promise<ToolOutcome> => ({ status: "ok", output: null }));
    // Simulates the host committing an override that kills a step target: the
    // compound must fall with it, not keep a route to the disabled tool.
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "vendo-bypass-"));
    try {
      await mkdir(join(root, ".vendo"));
      await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
        format: VENDO_TOOLS_FORMAT,
        tools: [routeTool("host_write", { risk: "write" })],
      }));
      await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({
        format: VENDO_OVERRIDES_FORMAT,
        tools: { host_write: { disabled: true } },
      }));
      await writeFile(join(root, ".vendo", "capabilities.json"), JSON.stringify(capabilities([
        compound("host_flow", [{ id: "a", tool: "host_write" }], { risk: "write" }),
      ])));
      const actions = createActions({ dir: root, invokeTool: seam });
      expect(await actions.execute(call("host_flow"), present)).toMatchObject({
        status: "error",
        error: { code: "not-found" },
      });
      expect(seam).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });

  it("defense in depth: even a registered compound refuses a step whose target stopped being primitive", async () => {
    const seam = vi.fn(async (): Promise<ToolOutcome> => ({ status: "ok", output: null }));
    const executor = createCompoundExecutor({
      config: { invokeTool: seam },
      // Simulates post-load drift: the name now resolves to something that is
      // not a host/connector primitive (e.g. add() shenanigans on reload).
      isPrimitive: async () => false,
    });
    const outcome = await executor.execute(
      compound("host_flow", [{ id: "a", tool: "host_read" }]),
      call("host_flow"),
      present,
    );
    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
    expect(seam).not.toHaveBeenCalled();
  });
});

describe("authority never leaks downward", () => {
  it("a compound-level grant is stripped before every step invocation", async () => {
    const stepContexts: RunContext[] = [];
    const invokeTool: ToolRegistry["execute"] = async (_stepCall, stepCtx) => {
      stepContexts.push(stepCtx);
      return { status: "ok", output: null };
    };
    const actions = createActions({
      tools: [routeTool("host_read"), routeTool("host_write", { risk: "write" })],
      capabilities: capabilities([
        compound("host_flow", [{ id: "a", tool: "host_read" }, { id: "b", tool: "host_write" }], { risk: "write" }),
      ]),
      invokeTool,
    });
    const grant = {
      id: "grt_compound",
      subject: "user_1",
      tool: "host_flow",
    } as unknown as PermissionGrant;
    const ctxWithGrant = { ...present, grant } as RunContext;

    await actions.execute(call("host_flow"), ctxWithGrant);

    expect(stepContexts).toHaveLength(2);
    for (const stepCtx of stepContexts) {
      // The compound's grant must never ride into a step's actAs: guard
      // re-decides each step and attaches the STEP's own grant if any.
      expect((stepCtx as ActionsRunContext).grant).toBeUndefined();
    }
  });
});

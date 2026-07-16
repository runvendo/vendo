import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VENDO_CAPABILITIES_FORMAT,
  VENDO_OVERRIDES_FORMAT,
  VENDO_TOOLS_FORMAT,
  type Json,
  type PermissionGrant,
  type RunContext,
  type Step,
  type ToolCall,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import type { CapabilitiesFile, CompoundTool, ExtractedTool } from "../formats.js";
import { createCompoundExecutor, validateCapabilities } from "./compound.js";
import { createActions, type ActionsRunContext } from "./registry.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_1" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
};

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function routeTool(name: string, extras: Partial<ExtractedTool> = {}): ExtractedTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/probe", argsIn: "query" },
    ...extras,
  };
}

function compound(name: string, steps: Step[], extras: Partial<CompoundTool> = {}): CompoundTool {
  return {
    name,
    description: `compound ${name}`,
    inputSchema: { type: "object" },
    risk: "read",
    binding: { kind: "compound", steps },
    ...extras,
  };
}

const capabilities = (tools: CompoundTool[], extras: Partial<CapabilitiesFile> = {}): CapabilitiesFile => ({
  format: VENDO_CAPABILITIES_FORMAT,
  tools,
  ...extras,
});

const hostTools = [
  routeTool("host_read"),
  routeTool("host_write", { risk: "write", binding: { kind: "route", method: "POST", path: "/write", argsIn: "body" } }),
  routeTool("host_destroy", { risk: "destructive", binding: { kind: "route", method: "DELETE", path: "/x", argsIn: "query" } }),
];

interface InvokeRecord {
  call: ToolCall;
  ctx: RunContext;
}

function invokeStub(respond: (call: ToolCall) => ToolOutcome = () => ({ status: "ok", output: "step-ok" })): {
  records: InvokeRecord[];
  invokeTool: ToolRegistry["execute"];
} {
  const records: InvokeRecord[] = [];
  return {
    records,
    invokeTool: async (call, callCtx) => {
      records.push({ call, ctx: callCtx });
      return respond(call);
    },
  };
}

const call = (tool: string, args: Json = {}, id = "call_compound_1"): ToolCall => ({ id, tool, args });

describe("capabilities loading and merge", () => {
  it("registers compounds from injected capabilities alongside host tools", async () => {
    const actions = createActions({
      tools: hostTools,
      capabilities: capabilities([
        compound("host_flow", [{ id: "a", tool: "host_read" }, { id: "b", tool: "host_write" }], { risk: "write" }),
      ]),
    });
    const descriptors = await actions.descriptors();
    const flow = descriptors.find((descriptor) => descriptor.name === "host_flow");
    expect(flow).toEqual({
      name: "host_flow",
      description: "compound host_flow",
      inputSchema: { type: "object" },
      risk: "write",
    });
  });

  it("reads .vendo/capabilities.json from dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-cap-"));
    roots.push(root);
    await mkdir(join(root, ".vendo"));
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({ format: VENDO_TOOLS_FORMAT, tools: hostTools }));
    await writeFile(join(root, ".vendo", "capabilities.json"), JSON.stringify(capabilities(
      [compound("host_flow", [{ id: "a", tool: "host_read" }])],
      { briefs: [{ name: "bulk", text: "loop host_read", tools: ["host_read"] }] },
    )));
    const actions = createActions({ dir: root });
    expect((await actions.descriptors()).map((descriptor) => descriptor.name)).toContain("host_flow");
    expect(await actions.briefs()).toEqual([{ name: "bulk", text: "loop host_read", tools: ["host_read"] }]);
  });

  it("throws loudly on malformed capabilities JSON, naming the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-cap-bad-"));
    roots.push(root);
    await mkdir(join(root, ".vendo"));
    await writeFile(join(root, ".vendo", "capabilities.json"), "{ not json");
    const actions = createActions({ dir: root });
    await expect(actions.descriptors()).rejects.toThrow(/Malformed JSON in .*capabilities\.json/);
  });

  it("throws loudly on a wrong format tag", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-cap-fmt-"));
    roots.push(root);
    await mkdir(join(root, ".vendo"));
    await writeFile(join(root, ".vendo", "capabilities.json"), JSON.stringify({ format: "vendo/capabilities@2", tools: [] }));
    const actions = createActions({ dir: root });
    await expect(actions.descriptors()).rejects.toThrow(/capabilities\.json/);
  });

  it("a compound name colliding with a tools.json tool is a conflict", async () => {
    const actions = createActions({
      tools: hostTools,
      capabilities: capabilities([compound("host_read", [{ id: "a", tool: "host_write" }], { risk: "write" })]),
    });
    await expect(actions.descriptors()).rejects.toThrow(/Duplicate tool name host_read/);
  });

  it("a compound name colliding with a connector tool is a conflict", async () => {
    const actions = createActions({
      tools: [],
      connectors: [{
        name: "stub",
        descriptors: async () => [{ name: "ext_send", description: "x", inputSchema: {}, risk: "write" }],
        execute: async () => ({ status: "ok", output: null }),
      }],
      capabilities: capabilities([compound("ext_send", [{ id: "a", tool: "ext_send" }], { risk: "write" })]),
    });
    await expect(actions.descriptors()).rejects.toThrow(/Duplicate tool name ext_send/);
  });

  it("overrides.json applies field-wise to compounds by name", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-cap-ovr-"));
    roots.push(root);
    await mkdir(join(root, ".vendo"));
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({ format: VENDO_TOOLS_FORMAT, tools: hostTools }));
    await writeFile(join(root, ".vendo", "capabilities.json"), JSON.stringify(capabilities([
      compound("host_flow", [{ id: "a", tool: "host_read" }]),
    ])));
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({
      format: VENDO_OVERRIDES_FORMAT,
      tools: { host_flow: { description: "reviewed copy", critical: true } },
    }));
    const actions = createActions({ dir: root });
    const flow = (await actions.descriptors()).find((descriptor) => descriptor.name === "host_flow");
    expect(flow).toMatchObject({ description: "reviewed copy", critical: true });
  });
});

describe("semantic validation quarantines, never bricks", () => {
  async function expectQuarantined(actions: ReturnType<typeof createActions>, name: string): Promise<void> {
    expect((await actions.descriptors()).map((descriptor) => descriptor.name)).not.toContain(name);
    const outcome = await actions.execute(call(name), ctx);
    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
  }

  it("quarantines a compound whose step references an unknown tool", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { invokeTool } = invokeStub();
    const actions = createActions({
      tools: hostTools,
      capabilities: capabilities([compound("host_flow", [{ id: "a", tool: "host_missing" }])]),
      invokeTool,
    });
    await expectQuarantined(actions, "host_flow");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("host_missing"));
  });

  it("quarantines a compound whose step references another compound (and itself)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const actions = createActions({
      tools: hostTools,
      capabilities: capabilities([
        compound("host_flow", [{ id: "a", tool: "host_other" }]),
        compound("host_other", [{ id: "a", tool: "host_other" }]),
      ]),
    });
    await expectQuarantined(actions, "host_flow");
    await expectQuarantined(actions, "host_other");
  });

  it("quarantines a compound whose step references a fn: capability tool", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const actions = createActions({
      tools: hostTools,
      capabilities: capabilities([compound("host_flow", [{ id: "a", tool: "fn:submit" }])]),
    });
    await expectQuarantined(actions, "host_flow");
  });

  it("quarantines a compound whose step references an add()-registry tool", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const actions = createActions({
      tools: hostTools,
      capabilities: capabilities([compound("host_flow", [{ id: "a", tool: "vendo_apps_call" }])]),
    });
    actions.add({
      descriptors: async () => [{ name: "vendo_apps_call", description: "x", inputSchema: {}, risk: "read" }],
      execute: async () => ({ status: "ok", output: null }),
    });
    await expectQuarantined(actions, "host_flow");
  });

  it("quarantines a compound whose step tool is disabled via override", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = await mkdtemp(join(tmpdir(), "vendo-cap-dis-"));
    roots.push(root);
    await mkdir(join(root, ".vendo"));
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({ format: VENDO_TOOLS_FORMAT, tools: hostTools }));
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({
      format: VENDO_OVERRIDES_FORMAT,
      tools: { host_read: { disabled: true } },
    }));
    await writeFile(join(root, ".vendo", "capabilities.json"), JSON.stringify(capabilities([
      compound("host_flow", [{ id: "a", tool: "host_read" }]),
    ])));
    const actions = createActions({ dir: root });
    await expectQuarantined(actions, "host_flow");
  });

  it("quarantines when declared risk understates the step max", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const actions = createActions({
      tools: hostTools,
      capabilities: capabilities([
        compound("host_flow", [{ id: "a", tool: "host_read" }, { id: "b", tool: "host_destroy" }], { risk: "write" }),
      ]),
    });
    await expectQuarantined(actions, "host_flow");
  });

  it("quarantines when declared risk overstates the step max", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const actions = createActions({
      tools: hostTools,
      capabilities: capabilities([
        compound("host_flow", [{ id: "a", tool: "host_read" }], { risk: "destructive" }),
      ]),
    });
    await expectQuarantined(actions, "host_flow");
  });

  it("quarantines when a risk override breaks the max invariant (post-merge step risks)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const root = await mkdtemp(join(tmpdir(), "vendo-cap-risk-"));
    roots.push(root);
    await mkdir(join(root, ".vendo"));
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({ format: VENDO_TOOLS_FORMAT, tools: hostTools }));
    // The step tool is upgraded to destructive; the compound still declares write.
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({
      format: VENDO_OVERRIDES_FORMAT,
      tools: { host_write: { risk: "destructive" } },
    }));
    await writeFile(join(root, ".vendo", "capabilities.json"), JSON.stringify(capabilities([
      compound("host_flow", [{ id: "a", tool: "host_write" }], { risk: "write" }),
    ])));
    const actions = createActions({ dir: root });
    await expectQuarantined(actions, "host_flow");
  });

  it("a disabled compound reserves its name for collision detection but never executes", async () => {
    const actions = createActions({
      tools: hostTools,
      capabilities: capabilities([
        compound("host_flow", [{ id: "a", tool: "host_read" }], { disabled: true }),
      ]),
    });
    expect((await actions.descriptors()).map((descriptor) => descriptor.name)).not.toContain("host_flow");
    expect(await actions.execute(call("host_flow"), ctx)).toMatchObject({ status: "error", error: { code: "not-found" } });

    // Name still reserved: a second tool with the same name collides.
    const colliding = createActions({
      tools: [...hostTools, routeTool("host_flow")],
      capabilities: capabilities([
        compound("host_flow", [{ id: "a", tool: "host_read" }], { disabled: true }),
      ]),
    });
    await expect(colliding.descriptors()).rejects.toThrow(/Duplicate tool name host_flow/);
  });

  it("validateCapabilities is the shared write-side seam returning per-tool issues", () => {
    const issues = validateCapabilities(
      {
        tools: [
          compound("good", [{ id: "a", tool: "host_read" }]),
          compound("bad_risk", [{ id: "a", tool: "host_write" }], { risk: "read" }),
          compound("bad_ref", [{ id: "a", tool: "fn:x" }, { id: "b", tool: "nope" }]),
        ],
      },
      new Map([
        ["host_read", { risk: "read" as const }],
        ["host_write", { risk: "write" as const }],
      ]),
    );
    expect(issues.filter((issue) => issue.tool === "good")).toHaveLength(0);
    expect(issues.filter((issue) => issue.tool === "bad_risk")).toHaveLength(1);
    expect(issues.filter((issue) => issue.tool === "bad_ref")).toHaveLength(2);
  });
});

describe("compound execution through the invokeTool seam", () => {
  const flow = compound("host_flow", [
    { id: "create", tool: "host_write", args: { amount: "args.amount" } },
    { id: "send", tool: "host_read", if: "args.email != null", args: { id: "steps.create.id", to: "args.email" } },
  ], { risk: "write" });

  it("walks steps IN ORDER through invokeTool with mapped args and returns the step outputs", async () => {
    const { records, invokeTool } = invokeStub((stepCall) =>
      stepCall.tool === "host_write" ? { status: "ok", output: { id: "inv_9" } } : { status: "ok", output: "sent" });
    const actions = createActions({ tools: hostTools, capabilities: capabilities([flow]), invokeTool });
    const outcome = await actions.execute(call("host_flow", { amount: 5, email: "a@x" }), ctx);
    expect(outcome).toEqual({ status: "ok", output: { steps: { create: { id: "inv_9" }, send: "sent" } } });
    expect(records.map((record) => record.call.tool)).toEqual(["host_write", "host_read"]);
    expect(records[0]!.call.args).toEqual({ amount: 5 });
    expect(records[1]!.call.args).toEqual({ id: "inv_9", to: "a@x" });
  });

  it("without invokeTool: not-implemented and NO work performed (host fetch untouched)", async () => {
    const fetchStub = vi.fn(async () => new Response("{}", { status: 200 }));
    const actions = createActions({
      tools: hostTools,
      baseUrl: "https://host.test",
      fetch: fetchStub as unknown as typeof fetch,
      capabilities: capabilities([flow]),
    });
    const outcome = await actions.execute(call("host_flow", { amount: 5 }), ctx);
    expect(outcome).toMatchObject({ status: "error", error: { code: "not-implemented" } });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("rejects non-object args", async () => {
    const { records, invokeTool } = invokeStub();
    const actions = createActions({ tools: hostTools, capabilities: capabilities([flow]), invokeTool });
    const outcome = await actions.execute(call("host_flow", [1, 2]), ctx);
    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
    expect(records).toHaveLength(0);
  });

  it("parks on a step approval and resumes the SAME logical call without re-running completed steps", async () => {
    let approve = false;
    const { records, invokeTool } = invokeStub((stepCall) => {
      if (stepCall.tool === "host_write" && !approve) return { status: "pending-approval", approvalId: "apr_1" };
      return { status: "ok", output: stepCall.tool };
    });
    const actions = createActions({ tools: hostTools, capabilities: capabilities([flow]), invokeTool });

    const parked = await actions.execute(call("host_flow", { amount: 5, email: "a@x" }), ctx);
    expect(parked).toEqual({ status: "pending-approval", approvalId: "apr_1" });
    const parkedCall = records[0]!.call;
    expect(parkedCall.tool).toBe("host_write");

    approve = true;
    records.splice(0);
    const resumed = await actions.execute(call("host_flow", { amount: 5, email: "a@x" }), ctx);
    expect(resumed).toMatchObject({ status: "ok" });
    // Parked step re-issued VERBATIM (same id + args), then the walk continues; no earlier step re-runs.
    expect(records[0]!.call).toEqual(parkedCall);
    expect(records.map((record) => record.call.tool)).toEqual(["host_write", "host_read"]);
  });

  it("resume state is isolated by subject, session, and args", async () => {
    const { records, invokeTool } = invokeStub((stepCall) =>
      stepCall.tool === "host_write" ? { status: "pending-approval", approvalId: "apr_1" } : { status: "ok", output: null });
    const actions = createActions({ tools: hostTools, capabilities: capabilities([flow]), invokeTool });
    const args = { amount: 5 };
    await actions.execute(call("host_flow", args), ctx);
    expect(records.map((record) => record.call.tool)).toEqual(["host_write"]);

    // Different subject: fresh walk (a new step call id is minted, not the parked one).
    const otherSubject: RunContext = { ...ctx, principal: { kind: "user", subject: "user_2" } };
    await actions.execute(call("host_flow", args), otherSubject);
    expect(records[1]!.call.id).not.toBe(records[0]!.call.id);

    // Different session: fresh walk.
    await actions.execute(call("host_flow", args), { ...ctx, sessionId: "session_2" });
    expect(records[2]!.call.id).not.toBe(records[0]!.call.id);

    // Same subject+session+id+args: resume hits the entry and re-issues verbatim.
    await actions.execute(call("host_flow", args), ctx);
    expect(records[3]!.call.id).toBe(records[0]!.call.id);

    // Same call id but DIFFERENT args: fresh walk (and the stale entry is dropped).
    await actions.execute(call("host_flow", { amount: 6 }), ctx);
    expect(records[4]!.call.id).not.toBe(records[0]!.call.id);
  });

  it("a different compound reusing the same call id can never hijack another compound's resume point", async () => {
    const other = compound("host_other_flow", [
      { id: "solo", tool: "host_read" },
    ]);
    const { records, invokeTool } = invokeStub((stepCall) =>
      stepCall.tool === "host_write" ? { status: "pending-approval", approvalId: "apr_1" } : { status: "ok", output: null });
    const actions = createActions({
      tools: hostTools,
      capabilities: capabilities([flow, other]),
      invokeTool,
    });

    // Park compound A with call id X.
    await actions.execute(call("host_flow", { amount: 5 }, "call_shared"), ctx);
    const parkedCall = records[0]!.call;
    expect(parkedCall.tool).toBe("host_write");

    // Invoke compound B with the SAME call id and identical args: it must walk
    // ITS OWN steps from the start, never re-issue A's approved pending call.
    records.splice(0);
    const outcome = await actions.execute(call("host_other_flow", { amount: 5 }, "call_shared"), ctx);
    expect(outcome).toMatchObject({ status: "ok" });
    expect(records.map((record) => record.call.tool)).toEqual(["host_read"]);
    expect(records[0]!.call.id).not.toBe(parkedCall.id);

    // A's resume point survives untouched: re-executing A resumes verbatim.
    records.splice(0);
    await actions.execute(call("host_flow", { amount: 5 }, "call_shared"), ctx);
    expect(records[0]!.call).toEqual(parkedCall);
  });

  it("terminal outcomes clear the resume entry", async () => {
    let mode: "park" | "error" | "ok" = "park";
    const { records, invokeTool } = invokeStub(() => {
      if (mode === "park") return { status: "pending-approval", approvalId: "apr_1" };
      if (mode === "error") return { status: "error", error: { code: "http-error", message: "500" } };
      return { status: "ok", output: null };
    });
    const actions = createActions({ tools: hostTools, capabilities: capabilities([flow]), invokeTool });
    await actions.execute(call("host_flow", { amount: 5 }), ctx);
    mode = "error";
    await actions.execute(call("host_flow", { amount: 5 }), ctx);
    mode = "ok";
    // Entry cleared by the error: this walk starts from step 0 with a fresh call id.
    await actions.execute(call("host_flow", { amount: 5 }), ctx);
    expect(records[2]!.call.id).not.toBe(records[0]!.call.id);
  });

  it("sweeps resume entries older than 60 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
    let park = true;
    const { records, invokeTool } = invokeStub(() => park
      ? { status: "pending-approval", approvalId: "apr_1" }
      : { status: "ok", output: null });
    const actions = createActions({ tools: hostTools, capabilities: capabilities([flow]), invokeTool });
    await actions.execute(call("host_flow", { amount: 5 }), ctx);
    park = false;
    vi.setSystemTime(new Date("2026-07-15T13:01:00Z"));
    await actions.execute(call("host_flow", { amount: 5 }), ctx);
    // Entry swept: fresh walk mints a new call id instead of re-issuing the parked one.
    expect(records[1]!.call.id).not.toBe(records[0]!.call.id);
  });

  it("bounds resume state at 1000 entries with oldest eviction", async () => {
    const { records, invokeTool } = invokeStub((stepCall) =>
      stepCall.tool === "host_write" ? { status: "pending-approval", approvalId: "apr_1" } : { status: "ok", output: null });
    const actions = createActions({ tools: hostTools, capabilities: capabilities([flow]), invokeTool });
    await actions.execute(call("host_flow", { amount: 5 }, "call_first"), ctx);
    const firstParked = records[0]!.call.id;
    for (let index = 0; index < 1000; index += 1) {
      await actions.execute(call("host_flow", { amount: 5 }, `call_fill_${index}`), ctx);
    }
    records.splice(0);
    // The oldest entry (call_first) was evicted: re-executing it starts fresh.
    await actions.execute(call("host_flow", { amount: 5 }, "call_first"), ctx);
    expect(records[0]!.call.id).not.toBe(firstParked);
  });

  it("strips grant from the step ctx and passes everything else through", async () => {
    const { records, invokeTool } = invokeStub();
    const actions = createActions({ tools: hostTools, capabilities: capabilities([flow]), invokeTool });
    const grant = { id: "grt_1", subject: "user_1", tool: "host_flow" } as unknown as PermissionGrant;
    const richCtx: ActionsRunContext = {
      ...ctx,
      appId: "app_1",
      trigger: { runId: "run_1", kind: "schedule" },
      requestHeaders: { cookie: "session=abc" },
      grant,
      mcpConsent: { clientId: "cli_1", scopes: ["tools"] },
    };
    await actions.execute(call("host_flow", { amount: 5 }), richCtx as RunContext);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      const stepCtx = record.ctx as ActionsRunContext;
      expect(stepCtx.grant).toBeUndefined();
      expect(stepCtx.principal).toEqual(richCtx.principal);
      expect(stepCtx.venue).toBe(richCtx.venue);
      expect(stepCtx.presence).toBe(richCtx.presence);
      expect(stepCtx.sessionId).toBe(richCtx.sessionId);
      expect(stepCtx.appId).toBe("app_1");
      expect(stepCtx.trigger).toEqual(richCtx.trigger);
      expect(stepCtx.requestHeaders).toEqual({ cookie: "session=abc" });
      expect(stepCtx.mcpConsent).toEqual({ clientId: "cli_1", scopes: ["tools"] });
    }
  });

  it("defense in depth: the walker refuses a step whose target is no longer a primitive tool", async () => {
    const { records, invokeTool } = invokeStub();
    const executor = createCompoundExecutor({
      config: { invokeTool },
      isPrimitive: async () => false,
    });
    const outcome = await executor.execute(flow, call("host_flow", { amount: 5 }), ctx);
    expect(outcome).toMatchObject({
      status: "error",
      error: { code: "validation", message: expect.stringContaining("not an enabled primitive") },
    });
    expect(records).toHaveLength(0);
  });
});

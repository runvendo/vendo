import {
  VENDO_APPS_CREATE_TOOL,
  VENDO_VIEW_STREAM,
  parseVendoToolEnvelope,
  vendoAppRefSchema,
  vendoApprovalRefSchema,
  type AgentRunner,
  type Json,
  type ToolDescriptor,
  type VendoViewStreamingToolCall,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { buildVendoToolPack, type VendoPackTool } from "./pack.js";
import { VENDO_CREATE_APP_TOOL, VENDO_DELEGATE_TOOL } from "./tool-pack.js";
import { boundRegistry, ctx, testGuard, type TestToolImplementation } from "./test-helpers.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const descriptor = (name: string, risk: ToolDescriptor["risk"] = "read"): ToolDescriptor => ({
  name,
  description: `${name} description`,
  inputSchema: { $schema: DRAFT_2020_12, type: "object" },
  risk,
});

function hostTools(): Record<string, TestToolImplementation> {
  return {
    host_lookup: {
      descriptor: descriptor("host_lookup"),
      execute: () => ({ rows: [1, 2, 3] }),
    },
    host_send: {
      descriptor: descriptor("host_send", "write"),
      execute: () => ({ sent: true }),
    },
    // Vendo-internal registry tools (vendo_-prefixed) must NOT be wrapped as
    // vendo_vendo_* — the pack's app door is the vendo_create_app built-in.
    vendo_doctor_present: {
      descriptor: descriptor("vendo_doctor_present"),
      execute: () => ({ ok: true }),
    },
  };
}

/** An apps-create double mirroring the real agent-tools implementation: it
 *  streams view parts through the call's VENDO_VIEW_STREAM bridge and returns
 *  the finished AppDocument. `gate` (when provided) holds completion open so
 *  tests can observe the fast-return path. */
function appsCreateTool(options: {
  appId: string;
  name: string;
  stream?: boolean;
  gate?: Promise<void>;
  onFinish?: () => void;
}): TestToolImplementation {
  return {
    descriptor: {
      name: VENDO_APPS_CREATE_TOOL,
      description: "Create a Vendo app from a natural-language prompt.",
      inputSchema: {
        $schema: DRAFT_2020_12,
        type: "object",
        properties: { prompt: { type: "string", minLength: 1 } },
        required: ["prompt"],
        additionalProperties: false,
      },
      risk: "read",
    },
    async execute(_args, _runCtx, call) {
      const stream = (call as VendoViewStreamingToolCall)[VENDO_VIEW_STREAM];
      if (options.stream !== false) {
        stream?.({
          id: `vendo-view-${options.appId}`,
          part: { type: "data-vendo-view", appId: options.appId, payload: { kind: "tree" } },
        });
      }
      if (options.gate !== undefined) await options.gate;
      options.onFinish?.();
      return { format: "vendo/app@1", id: options.appId, name: options.name, ui: "tree" } as unknown as Json;
    },
  };
}

const nullRunner: AgentRunner = async () => ({ status: "ok", summary: "noop", toolCalls: [] });

async function pack(options: {
  implementations?: Record<string, TestToolImplementation>;
  policy?: Record<string, "run" | "ask" | "block">;
  runner?: AgentRunner;
  include?: string[];
  exclude?: string[];
}): Promise<{
  tools: VendoPackTool[];
  byName: Map<string, VendoPackTool>;
  guard: ReturnType<typeof testGuard>;
  registry: ReturnType<typeof boundRegistry>;
}> {
  const guard = testGuard(options.policy ?? {});
  const registry = boundRegistry(options.implementations ?? hostTools(), guard);
  const tools = await buildVendoToolPack({
    registry,
    runner: options.runner ?? nullRunner,
    ...(options.include === undefined ? {} : { include: options.include }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
  });
  return { tools, byName: new Map(tools.map((tool) => [tool.name, tool])), guard, registry };
}

describe("buildVendoToolPack — composition and namespacing", () => {
  it("namespaces every host tool under vendo_ and adds the two built-ins", async () => {
    const { tools } = await pack({
      implementations: {
        ...hostTools(),
        [VENDO_APPS_CREATE_TOOL]: appsCreateTool({ appId: "app_composed", name: "unused" }),
      },
    });
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      VENDO_CREATE_APP_TOOL,
      VENDO_DELEGATE_TOOL,
      "vendo_host_lookup",
      "vendo_host_send",
    ]);
  });

  it("never double-wraps Vendo-internal registry tools", async () => {
    const { tools } = await pack({});
    for (const tool of tools) {
      expect(tool.name.startsWith("vendo_vendo_")).toBe(false);
    }
  });

  it("carries the descriptor's description and input schema on each wrapped tool", async () => {
    const { byName } = await pack({});
    const lookup = byName.get("vendo_host_lookup")!;
    expect(lookup.description).toBe("host_lookup description");
    expect(lookup.inputSchema).toEqual({ $schema: DRAFT_2020_12, type: "object" });
  });

  it("include filters on FINAL namespaced names (built-ins included)", async () => {
    const { tools } = await pack({ include: ["vendo_host_lookup", VENDO_DELEGATE_TOOL] });
    expect(tools.map((tool) => tool.name).sort()).toEqual([VENDO_DELEGATE_TOOL, "vendo_host_lookup"]);
  });

  it("exclude wins over include", async () => {
    const { tools } = await pack({
      include: ["vendo_host_lookup", "vendo_host_send"],
      exclude: ["vendo_host_send"],
    });
    expect(tools.map((tool) => tool.name)).toEqual(["vendo_host_lookup"]);
  });
});

describe("buildVendoToolPack — guard-bound execution", () => {
  it("a clean call routes through the guard-bound registry and returns plain data", async () => {
    const { byName, guard, registry } = await pack({});
    const output = await byName.get("vendo_host_lookup")!.execute({}, { ctx: ctx() });
    expect(output).toEqual({ rows: [1, 2, 3] });
    expect(parseVendoToolEnvelope(output)).toBeNull();
    expect(registry.invocations["host_lookup"]).toBe(1);
    expect(guard.events).toHaveLength(1);
    expect(guard.events[0]).toMatchObject({ kind: "tool-call", tool: "host_lookup", outcome: "ok" });
  });

  it("an ask-policy call returns the approval-ref envelope without throwing and without executing", async () => {
    const { byName, guard, registry } = await pack({ policy: { host_send: "ask" } });
    const output = await byName.get("vendo_host_send")!.execute(
      { to: "client_1" },
      { ctx: ctx(), callId: "call_pack_send" },
    );
    const envelope = vendoApprovalRefSchema.parse(output);
    expect(envelope.approvalId).toBe("apr_call_pack_send");
    expect(envelope.summary).toContain("host_send");
    expect(envelope.summary).not.toContain("\n");
    expect(registry.invocations["host_send"]).toBe(0);
    expect(guard.pending()).toHaveLength(1);
  });

  it("a blocked call returns the blocked outcome as plain data — no envelope, no throw", async () => {
    const { byName } = await pack({ policy: { host_send: "block" } });
    const output = await byName.get("vendo_host_send")!.execute({}, { ctx: ctx() });
    expect(output).toMatchObject({ status: "blocked" });
    expect(parseVendoToolEnvelope(output)).toBeNull();
  });

  it("a REJECTING registry surfaces a generic execution error, never the raw rejection", async () => {
    const rejecting = {
      descriptors: async () => [descriptor("host_lookup")],
      execute: async () => {
        throw new Error("secret internal detail");
      },
    };
    const tools = await buildVendoToolPack({ registry: rejecting, runner: nullRunner });
    const output = await tools.find((tool) => tool.name === "vendo_host_lookup")!.execute({}, { ctx: ctx() });
    expect(output).toEqual({
      status: "error",
      error: { code: "execution", message: "Tool execution failed." },
    });
  });

  it("mints a call id when the host loop does not supply one", async () => {
    const { byName, guard } = await pack({ policy: { host_send: "ask" } });
    const output = await byName.get("vendo_host_send")!.execute({}, { ctx: ctx() });
    vendoApprovalRefSchema.parse(output);
    expect(guard.pending()).toHaveLength(1);
    expect(guard.pending()[0]!.id.startsWith("apr_")).toBe(true);
  });
});

describe("vendo_create_app", () => {
  it("returns the app-ref envelope from the FIRST streamed view part, before the build completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let finished = false;
    const implementations = {
      ...hostTools(),
      [VENDO_APPS_CREATE_TOOL]: appsCreateTool({
        appId: "app_fast",
        name: "Weather dashboard",
        gate,
        onFinish: () => { finished = true; },
      }),
    };
    const { byName } = await pack({ implementations });
    const output = await byName.get(VENDO_CREATE_APP_TOOL)!.execute(
      { prompt: "Compare weather in 3 cities" },
      { ctx: ctx() },
    );
    const envelope = vendoAppRefSchema.parse(output);
    expect(envelope.appId).toBe("app_fast");
    expect(envelope.title).toBe("Compare weather in 3 cities");
    expect(finished).toBe(false);
    release();
  });

  it("derives the fast-path title from the prompt, capped to one 80-char line", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const implementations = {
      ...hostTools(),
      [VENDO_APPS_CREATE_TOOL]: appsCreateTool({ appId: "app_long", name: "ignored", gate }),
    };
    const { byName } = await pack({ implementations });
    const prompt = `build me a dashboard ${"with lots of panels ".repeat(10)}`;
    const output = await byName.get(VENDO_CREATE_APP_TOOL)!.execute({ prompt }, { ctx: ctx() });
    const envelope = vendoAppRefSchema.parse(output);
    expect(envelope.title.length).toBeLessThanOrEqual(80);
    expect(envelope.title.endsWith("…")).toBe(true);
    release();
  });

  it("without a streamed view part, returns the app-ref from the finished document", async () => {
    const implementations = {
      ...hostTools(),
      [VENDO_APPS_CREATE_TOOL]: appsCreateTool({ appId: "app_done", name: "Trip planner", stream: false }),
    };
    const { byName } = await pack({ implementations });
    const output = await byName.get(VENDO_CREATE_APP_TOOL)!.execute(
      { prompt: "plan my trip" },
      { ctx: ctx() },
    );
    const envelope = vendoAppRefSchema.parse(output);
    expect(envelope).toMatchObject({ appId: "app_done", title: "Trip planner" });
  });

  it("an ask-policy create parks and returns the approval-ref envelope", async () => {
    const implementations = {
      ...hostTools(),
      [VENDO_APPS_CREATE_TOOL]: appsCreateTool({ appId: "app_asked", name: "unused" }),
    };
    const { byName, registry } = await pack({
      implementations,
      policy: { [VENDO_APPS_CREATE_TOOL]: "ask" },
    });
    const output = await byName.get(VENDO_CREATE_APP_TOOL)!.execute(
      { prompt: "make a dashboard" },
      { ctx: ctx() },
    );
    vendoApprovalRefSchema.parse(output);
    expect(registry.invocations[VENDO_APPS_CREATE_TOOL]).toBe(0);
  });

  it("is absent from the pack when the registry has no vendo_apps_create", async () => {
    const { byName } = await pack({ implementations: hostTools() });
    expect(byName.has(VENDO_CREATE_APP_TOOL)).toBe(false);
  });
});

describe("vendo_delegate", () => {
  it("returns the run report as VendoDelegateResult with refs to everything the run produced", async () => {
    const implementations = {
      ...hostTools(),
      [VENDO_APPS_CREATE_TOOL]: appsCreateTool({ appId: "app_delegated", name: "Report app", stream: false }),
    };
    // A runner double that drives the task's OWN registry — the seam the real
    // agent.asRunner() uses — so ref capture is observed at the registry wrap.
    const runner: AgentRunner = async (task, runCtx) => {
      await task.tools.execute({ id: "call_d1", tool: VENDO_APPS_CREATE_TOOL, args: { prompt: "report" } }, runCtx);
      const parked = await task.tools.execute({ id: "call_d2", tool: "host_send", args: { to: "x" } }, runCtx);
      expect(parked.status).toBe("pending-approval");
      return { status: "ok", summary: "Made a report app; one send awaits approval.", toolCalls: [] };
    };
    const { byName } = await pack({
      implementations,
      policy: { host_send: "ask" },
      runner,
    });
    const output = await byName.get(VENDO_DELEGATE_TOOL)!.execute(
      { task: "make a report and send it" },
      { ctx: ctx() },
    ) as { status: string; summary: string; refs: unknown[] };
    expect(output.status).toBe("ok");
    expect(output.summary).toBe("Made a report app; one send awaits approval.");
    expect(output.refs).toHaveLength(2);
    expect(vendoAppRefSchema.parse(output.refs[0])).toMatchObject({ appId: "app_delegated", title: "Report app" });
    expect(vendoApprovalRefSchema.parse(output.refs[1]).approvalId).toBe("apr_call_d2");
  });

  it("a runner failure returns an error-status result instead of throwing", async () => {
    const runner: AgentRunner = async () => {
      throw new Error("runner exploded");
    };
    const { byName } = await pack({ runner });
    const output = await byName.get(VENDO_DELEGATE_TOOL)!.execute(
      { task: "anything" },
      { ctx: ctx() },
    ) as { status: string; refs: unknown[] };
    expect(output.status).toBe("error");
    expect(output.refs).toEqual([]);
  });
});

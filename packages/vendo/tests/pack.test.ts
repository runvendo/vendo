import {
  VENDO_MAKE_TOOL,
  VENDO_TREE_FORMAT,
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
import { buildVendoToolPack, type VendoPackTool } from "../src/pack.js";
import { VENDO_DELEGATE_TOOL } from "../src/tool-pack.js";
import { boundRegistry, ctx, testGuard, type TestToolImplementation } from "../src/agent-doubles.test-util.js";

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
    // vendo_vendo_* — the pack's app door is the vendo_make built-in itself.
    vendo_doctor_present: {
      descriptor: descriptor("vendo_doctor_present"),
      execute: () => ({ ok: true }),
    },
  };
}

/** A `vendo_make` double mirroring the real agent-tools implementation: it
 *  streams view parts through the call's VENDO_VIEW_STREAM bridge and answers
 *  with a MakeReceipt — never the AppDocument, which no longer travels on the
 *  tool channel at all. `gate` (when provided) holds completion open so tests
 *  can observe the fast-return path. */
function makeTool(options: {
  appId: string;
  name: string;
  stream?: boolean;
  gate?: Promise<void>;
  onFinish?: () => void;
}): TestToolImplementation {
  return {
    descriptor: {
      name: VENDO_MAKE_TOOL,
      description: "Make the user something to look at, from a plain-language request.",
      inputSchema: {
        $schema: DRAFT_2020_12,
        type: "object",
        properties: {
          request: { type: "string", minLength: 1 },
          app: { type: "string", minLength: 1 },
        },
        required: ["request"],
        additionalProperties: false,
      },
      risk: "read",
    },
    async execute(_args, _runCtx, call) {
      const stream = (call as VendoViewStreamingToolCall)[VENDO_VIEW_STREAM];
      if (options.stream !== false) {
        stream?.({
          id: `vendo-view-${options.appId}`,
          part: { type: "data-vendo-view", appId: options.appId, payload: { kind: "tree", formatVersion: VENDO_TREE_FORMAT } },
        });
      }
      if (options.gate !== undefined) await options.gate;
      options.onFinish?.();
      return {
        id: options.appId,
        title: options.name,
        status: "ready",
        say: `${options.name} is on your screen.`,
      } as unknown as Json;
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
        [VENDO_MAKE_TOOL]: makeTool({ appId: "app_composed", name: "unused" }),
      },
    });
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      VENDO_DELEGATE_TOOL,
      "vendo_host_lookup",
      "vendo_host_send",
      VENDO_MAKE_TOOL,
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

describe("vendo_make (the pack's app door)", () => {
  it("returns the app-ref envelope from the FIRST streamed view part, before the build completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let finished = false;
    const implementations = {
      ...hostTools(),
      [VENDO_MAKE_TOOL]: makeTool({
        appId: "app_fast",
        name: "Weather dashboard",
        gate,
        onFinish: () => { finished = true; },
      }),
    };
    const { byName } = await pack({ implementations });
    const output = await byName.get(VENDO_MAKE_TOOL)!.execute(
      { request: "Compare weather in 3 cities" },
      { ctx: ctx() },
    );
    const envelope = vendoAppRefSchema.parse(output);
    expect(envelope.appId).toBe("app_fast");
    expect(envelope.title).toBe("Compare weather in 3 cities");
    expect(finished).toBe(false);
    release();
  });

  it("derives the fast-path title from the request, capped to one 80-char line", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const implementations = {
      ...hostTools(),
      [VENDO_MAKE_TOOL]: makeTool({ appId: "app_long", name: "ignored", gate }),
    };
    const { byName } = await pack({ implementations });
    const request = `build me a dashboard ${"with lots of panels ".repeat(10)}`;
    const output = await byName.get(VENDO_MAKE_TOOL)!.execute({ request }, { ctx: ctx() });
    const envelope = vendoAppRefSchema.parse(output);
    expect(envelope.title.length).toBeLessThanOrEqual(80);
    expect(envelope.title.endsWith("…")).toBe(true);
    release();
  });

  it("without a streamed view part, returns the app-ref built from the finished RECEIPT", async () => {
    const implementations = {
      ...hostTools(),
      [VENDO_MAKE_TOOL]: makeTool({ appId: "app_done", name: "Trip planner", stream: false }),
    };
    const { byName } = await pack({ implementations });
    const output = await byName.get(VENDO_MAKE_TOOL)!.execute(
      { request: "plan my trip" },
      { ctx: ctx() },
    );
    const envelope = vendoAppRefSchema.parse(output);
    // `title` is the receipt's, not the request-derived fallback ("plan my
    // trip") — which is the proof the ref was read off the receipt rather than
    // off a document that no longer arrives.
    expect(envelope).toMatchObject({ appId: "app_done", title: "Trip planner" });
  });

  it("a receipt-shaped answer is the ONLY thing the ref is built from", async () => {
    // A registry that answers with the old AppDocument gets no ref: the pack
    // hands its output straight back rather than inventing an envelope from a
    // shape the contract no longer produces.
    const implementations = {
      ...hostTools(),
      [VENDO_MAKE_TOOL]: {
        descriptor: makeTool({ appId: "app_legacy", name: "Legacy" }).descriptor,
        execute: () => ({ format: "vendo/app@1", id: "app_legacy", name: "Legacy", ui: "tree" }),
      },
    };
    const { byName } = await pack({ implementations });
    const output = await byName.get(VENDO_MAKE_TOOL)!.execute(
      { request: "plan my trip" },
      { ctx: ctx() },
    );
    expect(vendoAppRefSchema.safeParse(output).success).toBe(false);
  });

  it("an ask-policy create parks and returns the approval-ref envelope", async () => {
    const implementations = {
      ...hostTools(),
      [VENDO_MAKE_TOOL]: makeTool({ appId: "app_asked", name: "unused" }),
    };
    const { byName, registry } = await pack({
      implementations,
      policy: { [VENDO_MAKE_TOOL]: "ask" },
    });
    const output = await byName.get(VENDO_MAKE_TOOL)!.execute(
      { request: "make a dashboard" },
      { ctx: ctx() },
    );
    vendoApprovalRefSchema.parse(output);
    expect(registry.invocations[VENDO_MAKE_TOOL]).toBe(0);
  });

  it("is absent from the pack when the registry has no vendo_make", async () => {
    const { byName } = await pack({ implementations: hostTools() });
    expect(byName.has(VENDO_MAKE_TOOL)).toBe(false);
  });

  // runvendo/flowlet#822 defect 2: the fast ref wins the race against the
  // build's real outcome on essentially every generation that streams any
  // content before failing (the common case for a wire-validation failure).
  // A calling model narrated three fabricated successes off an envelope that
  // carried only an appId and a title — nothing distinguishing "accepted,
  // outcome unknown" from "done". The envelope must say so itself, in a field
  // a model cannot skim past, on BOTH the fast path and the (rarer) case
  // where the build's own success outruns the stream.
  it("the fast-path ref is machine-readable as still-building, not a finished resource", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const implementations = {
      ...hostTools(),
      [VENDO_MAKE_TOOL]: makeTool({ appId: "app_fast", name: "Weather dashboard", gate }),
    };
    const { byName } = await pack({ implementations });
    const output = await byName.get(VENDO_MAKE_TOOL)!.execute(
      { request: "Compare weather in 3 cities" },
      { ctx: ctx() },
    );
    const envelope = vendoAppRefSchema.parse(output);
    expect(envelope.status).toBe("building");
    release();
  });

  it("without a streamed view part, the ref built from the finished receipt is STILL marked building — this tool never tells the model a build is done", async () => {
    const implementations = {
      ...hostTools(),
      [VENDO_MAKE_TOOL]: makeTool({ appId: "app_done", name: "Trip planner", stream: false }),
    };
    const { byName } = await pack({ implementations });
    const output = await byName.get(VENDO_MAKE_TOOL)!.execute(
      { request: "plan my trip" },
      { ctx: ctx() },
    );
    expect(vendoAppRefSchema.parse(output).status).toBe("building");
  });

  it("the tool description forbids narrating a build as done or inventing its contents", async () => {
    const { byName } = await pack({
      implementations: { ...hostTools(), [VENDO_MAKE_TOOL]: makeTool({ appId: "app_x", name: "x" }) },
    });
    const description = byName.get(VENDO_MAKE_TOOL)!.description;
    expect(description).toContain("building");
    expect(description).toMatch(/never describe|never say it is created/i);
  });

  it("takes vendo_make's own arguments: request required, context/app/slot optional", async () => {
    const { byName } = await pack({
      implementations: { ...hostTools(), [VENDO_MAKE_TOOL]: makeTool({ appId: "app_schema", name: "x" }) },
    });
    expect(byName.get(VENDO_MAKE_TOOL)!.inputSchema).toEqual({
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        request: { type: "string", minLength: 1 },
        context: { type: "string", minLength: 1 },
        app: { type: "string", minLength: 1 },
        slot: { type: "string", minLength: 1 },
      },
      required: ["request"],
      additionalProperties: false,
    });
  });

  /** Parity with the MCP door: an in-process agent can say where the screen
   *  lands, and the slot reaches the same `vendo_make` handler that claims it. */
  it("takes `slot` and forwards it to vendo_make", async () => {
    const seen: Json[] = [];
    const implementations = {
      ...hostTools(),
      [VENDO_MAKE_TOOL]: {
        descriptor: makeTool({ appId: "app_slot", name: "Spending" }).descriptor,
        execute: (args: Json): Json => {
          seen.push(args);
          return { id: "app_slot", title: "Spending", status: "ready", say: "Spending is on your screen." };
        },
      },
    };
    const { byName } = await pack({ implementations });
    const tool = byName.get(VENDO_MAKE_TOOL)!;
    expect((tool.inputSchema as { properties: Record<string, unknown> }).properties.slot).toEqual({
      type: "string",
      minLength: 1,
    });
    await tool.execute({ request: "this month's spending", slot: "home-hero" }, { ctx: ctx() });
    expect(seen).toEqual([{ request: "this month's spending", slot: "home-hero" }]);
  });

  it("forwards the caller's arguments to vendo_make verbatim — nothing is translated", async () => {
    const seen: Json[] = [];
    const implementations = {
      ...hostTools(),
      [VENDO_MAKE_TOOL]: {
        descriptor: makeTool({ appId: "app_fwd", name: "Forwarded" }).descriptor,
        execute: (args: Json): Json => {
          seen.push(args);
          return { id: "app_fwd", title: "Forwarded", status: "ready", say: "Forwarded is on your screen." };
        },
      },
    };
    const { byName } = await pack({ implementations });
    await byName.get(VENDO_MAKE_TOOL)!.execute(
      { request: "add a column", app: "app_fwd", context: "the invoices table" },
      { ctx: ctx() },
    );
    expect(seen).toEqual([
      { request: "add a column", app: "app_fwd", context: "the invoices table" },
    ]);
  });
});

describe("vendo_delegate", () => {
  it("returns the run report as VendoDelegateResult with refs to everything the run produced", async () => {
    const implementations = {
      ...hostTools(),
      [VENDO_MAKE_TOOL]: makeTool({ appId: "app_delegated", name: "Report app", stream: false }),
    };
    // A runner double that drives the task's OWN registry — the seam the real
    // agent.asRunner() uses — so ref capture is observed at the registry wrap.
    const runner: AgentRunner = async (task, runCtx) => {
      await task.tools.execute({ id: "call_d1", tool: VENDO_MAKE_TOOL, args: { request: "report" } }, runCtx);
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

  // runvendo/flowlet#822 defect 2, generalized: `vendo_make` answers a failed
  // EDIT with an ok outcome whose MakeReceipt carries status:"failed" and a
  // speakable `say` (agent-tools.ts's vendo_make handler) — a soft failure,
  // never a throw, by design. Ref capture must not launder that failure into
  // a bare {kind, appId, title} ref: an appId and a title are indistinguishable
  // from a completed edit, so the delegate's caller would read this as one
  // more successful change.
  it("never turns a failed EDIT's receipt into a success-shaped ref", async () => {
    const implementations = {
      ...hostTools(),
      [VENDO_MAKE_TOOL]: {
        descriptor: makeTool({ appId: "app_edit", name: "Report app" }).descriptor,
        execute: () => ({
          id: "app_edit",
          title: "Report app",
          status: "failed",
          say: "I couldn't make that change to Report app.",
        } as unknown as Json),
      },
    };
    const runner: AgentRunner = async (task, runCtx) => {
      const outcome = await task.tools.execute(
        { id: "call_edit", tool: VENDO_MAKE_TOOL, args: { request: "add a column", app: "app_edit" } },
        runCtx,
      );
      expect(outcome.status).toBe("ok");
      return { status: "ok", summary: "Couldn't make that change to Report app.", toolCalls: [] };
    };
    const { byName } = await pack({ implementations, runner });
    const output = await byName.get(VENDO_DELEGATE_TOOL)!.execute(
      { task: "add a column to the report" },
      { ctx: ctx() },
    ) as { status: string; refs: unknown[] };
    expect(output.status).toBe("ok");
    // No ref at all beats a false one: refs are read as "this exists and is
    // fine", and a failed edit is neither.
    expect(output.refs).toEqual([]);
  });
});

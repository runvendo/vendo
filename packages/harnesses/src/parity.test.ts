/**
 * Regression tests for the verifier's findings on the first attempt at this lane.
 * Each one failed before the lift; together they are the proof that the harness
 * rides the SHIPPED rails instead of a parallel reimplementation.
 */
import {
  VENDO_APPS_CREATE_TOOL,
  VENDO_VIEW_STREAM,
  VendoError,
  vendoViewStreamId,
  type ApprovalId,
  type ThreadId,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
  type VendoViewStreamingToolCall,
} from "@vendoai/core";
import { wireErrorMessage } from "@vendoai/agent/internal";
import { describe, expect, it, vi } from "vitest";
import { defineHarness } from "./define.js";
import { createHarnessRuntime } from "./runtime.js";
import { wrapWorkspaceForRender, viewForWrite } from "./render-seam.js";
import {
  boundRegistry,
  ctx,
  readSse,
  readTool,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  unusedModels,
  userMessage,
} from "./test-doubles.test-util.js";

const THREAD = "thr_parity" as ThreadId;
const APP_TREE = {
  kind: "tree",
  appId: "app_1",
  payload: { formatVersion: "vendo-genui/v2", root: "r", nodes: [{ id: "r", component: "Text" }] },
};

function runtimeFor(options: {
  registry: ToolRegistry;
  guard: ReturnType<typeof testGuard>;
  approvalWaitMs?: number;
}) {
  const transcript = testTranscript();
  const runtime = createHarnessRuntime({
    tools: options.registry,
    guard: options.guard,
    skills: testSkills(),
    transcript,
    ...(options.approvalWaitMs === undefined ? {} : { approvalWaitMs: options.approvalWaitMs }),
  });
  const run = async (harness: Parameters<typeof runtime.run>[0]["harness"], interactive = true) =>
    readSse(
      await runtime.run({
        harness,
        threadId: THREAD,
        messages: [userMessage("m1", "go")],
        ctx: ctx(),
        workspace: testWorkspace(),
        models: unusedModels(),
        interactive,
      }),
    );
  return { run, transcript };
}

describe("C1 — generating or opening an app RENDERS", () => {
  const appsTool: ToolDescriptor = {
    ...readTool(VENDO_APPS_CREATE_TOOL, "write"),
    name: VENDO_APPS_CREATE_TOOL,
  };

  it("emits data-vendo-view from a vendo_apps_* tree OpenSurface, on the app's stream id", async () => {
    const guard = testGuard();
    const registry = boundRegistry(
      { [VENDO_APPS_CREATE_TOOL]: { descriptor: appsTool, execute: () => APP_TREE } },
      guard,
    );
    const { run } = runtimeFor({ registry, guard });
    const parts = await run(
      defineHarness({
        name: "builder",
        async *run(turn) {
          await turn.tools.call(VENDO_APPS_CREATE_TOOL, { appId: "app_1" });
        },
      }),
    );
    const view = parts.find((part) => part.type === "data-vendo-view");
    expect(view).toMatchObject({ id: vendoViewStreamId("app_1"), data: { appId: "app_1" } });
  });

  it("carries the VENDO_VIEW_STREAM partial bridge, so the app grows on screen mid-build", async () => {
    const guard = testGuard();
    // The runtime must attach the symbol to the call, exactly as the shipped
    // bridge does — that is how the engine streams partial trees.
    const registry: ToolRegistry = {
      descriptors: async () => [appsTool],
      execute: async (call): Promise<ToolOutcome> => {
        const publish = (call as VendoViewStreamingToolCall)[VENDO_VIEW_STREAM];
        expect(publish).toBeTypeOf("function");
        publish?.({
          id: vendoViewStreamId("app_1"),
          part: { type: "data-vendo-view", appId: "app_1", payload: APP_TREE.payload as never },
        });
        return { status: "ok", output: APP_TREE as never };
      },
    };
    const { run } = runtimeFor({ registry, guard });
    const parts = await run(
      defineHarness({
        name: "builder",
        async *run(turn) {
          await turn.tools.call(VENDO_APPS_CREATE_TOOL, { appId: "app_1" });
        },
      }),
    );
    // One partial + one final, both on the same reconciling stream id.
    const views = parts.filter((part) => part.type === "data-vendo-view");
    expect(views.length).toBeGreaterThanOrEqual(2);
    expect(views.every((part) => part.id === vendoViewStreamId("app_1"))).toBe(true);
  });

  it("raises the build-failed banner a terminally failed build must show", async () => {
    const guard = testGuard();
    const registry = boundRegistry(
      {
        [VENDO_APPS_CREATE_TOOL]: {
          descriptor: appsTool,
          execute: () => {
            throw new Error("app build failed: the plan referenced a component that does not exist");
          },
        },
      },
      guard,
    );
    const { run } = runtimeFor({ registry, guard });
    const parts = await run(
      defineHarness({
        name: "builder",
        async *run(turn) {
          await turn.tools.call(VENDO_APPS_CREATE_TOOL, { appId: "app_1" });
        },
      }),
    );
    expect(parts.some((part) => part.type === "data-vendo-build-failed")).toBe(true);
  });
});

describe("C2 — the failure affordance is today's, wireErrorMessage and all", () => {
  it("keeps a Vendo error's message and code", () => {
    expect(wireErrorMessage(new VendoError("cloud-required", "this deployment's plan does not include app machines")))
      .toBe("Vendo: this deployment's plan does not include app machines (cloud-required)");
  });

  it("turns the Cloud meter's 402 into the sentence with figures, reset date and both exits", () => {
    const refusal = Object.assign(new Error("Payment Required"), {
      name: "AI_APICallError",
      statusCode: 402,
      responseBody: JSON.stringify({
        code: "meter-exhausted",
        meter: "ai_tokens",
        used: 1_204_000,
        limit: 1_000_000,
        resets_at: "2026-08-01T00:00:00.000Z",
        reason: "allowance",
        exits: {
          upgrade_url: "https://console.vendo.run/billing",
          byo_docs_url: "https://docs.vendo.run/byo",
        },
      }),
    });
    const message = wireErrorMessage(refusal);
    expect(message).toContain("1,204,000 of 1,000,000 used");
    expect(message).toContain("resets 2026-08-01");
    expect(message).toContain("https://console.vendo.run/billing");
    expect(message).toContain("https://docs.vendo.run/byo");
    expect(message).toContain("(cloud-required)");
  });

  it("never lets provider internals travel", () => {
    expect(wireErrorMessage(new Error("connect ECONNREFUSED key=sk-123"))).toBe(
      "An error occurred while generating the response.",
    );
  });
});

describe("one operator log per error, not two", () => {
  it("writing the error chunk does not also trip the stream's onError log", async () => {
    const guard = testGuard();
    const { run } = runtimeFor({ registry: boundRegistry({}, guard), guard });
    const logs: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logs.push(args);
    });
    try {
      await run(
        defineHarness({
          name: "vendo",
          async *run() {
            // Already `wireErrorMessage`-shaped: the harness logged the REAL error
            // when it formatted this, so the runtime must not log it again — and
            // writing the error chunk trips createUIMessageStream's onError too.
            yield { type: "error", message: "Vendo: the meter is exhausted (cloud-required)" };
          },
        }),
      );
    } finally {
      spy.mockRestore();
    }
    const streamLogs = logs.filter((entry) => String(entry[0]).includes("harness stream error"));
    expect(streamLogs).toHaveLength(0);
  });

  it("still logs a fault the runtime alone saw", async () => {
    const guard = testGuard();
    const { run } = runtimeFor({ registry: boundRegistry({}, guard), guard });
    const logs: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logs.push(args);
    });
    try {
      await run(
        defineHarness({
          name: "explodes",
          async *run() {
            throw new Error("a real bug in the thinker");
          },
        }),
      );
    } finally {
      spy.mockRestore();
    }
    const runFailed = logs.filter((entry) => String(entry[0]).includes("harness run failed"));
    expect(runFailed).toHaveLength(1);
  });
});

describe("C4 — an approved call executes ONCE", () => {
  it("previews with previewCheck and never double-charges the guard", async () => {
    const guard = testGuard({ pay: "ask" });
    let previewCalls = 0;
    let checkCalls = 0;
    const realCheck = guard.check.bind(guard);
    guard.previewCheck = async (call, descriptor, runCtx) => {
      previewCalls += 1;
      const decision = await realCheck(call, descriptor, runCtx);
      // Tap immediately, so the wait resolves and the real call proceeds.
      if (decision.action === "ask") guard.decide(decision.approval.id, true);
      return decision;
    };
    guard.check = async (call, descriptor, runCtx) => {
      checkCalls += 1;
      return realCheck(call, descriptor, runCtx);
    };
    const registry = boundRegistry(
      { pay: { descriptor: readTool("pay", "destructive"), execute: () => ({ sent: true }) } },
      guard,
    );
    const { run } = runtimeFor({ registry, guard, approvalWaitMs: 200 });
    await run(
      defineHarness({
        name: "payer",
        async *run(turn) {
          const result = await turn.tools.call("pay", { amount: 10 });
          expect(result).toEqual({ status: "ok", output: { sent: true } });
        },
      }),
    );
    // The exact split the shipped ai-SDK path produces: one preview (no breaker
    // spend, no judge), one real check inside the single execution.
    expect(previewCalls).toBe(1);
    expect(checkCalls).toBe(1);
    expect(registry.invocations.pay).toBe(1);
  });
});

describe("H1 — a timed-out approval does not orphan", () => {
  it("is abandoned at turn end, so the pending queue does not grow forever", async () => {
    const guard = testGuard({ pay: "ask" });
    const abandoned: ApprovalId[] = [];
    guard.abandonApprovals = async (ids) => {
      abandoned.push(...ids);
      for (const id of ids) guard.decide(id, false);
    };
    const registry = boundRegistry(
      { pay: { descriptor: readTool("pay", "destructive"), execute: () => 1 } },
      guard,
    );
    const { run } = runtimeFor({ registry, guard, approvalWaitMs: 15 });
    await run(
      defineHarness({
        name: "payer",
        async *run(turn) {
          const result = await turn.tools.call("pay", { amount: 10 });
          expect(result.status).toBe("denied");
        },
      }),
    );
    await vi.waitFor(() => expect(abandoned).toHaveLength(1));
    expect(guard.pending()).toHaveLength(0);
  });
});

describe("H2 — turn.messages is genuinely ours", () => {
  it("a harness cannot rewrite canonical history through a part", async () => {
    const guard = testGuard();
    const registry = boundRegistry({}, guard);
    const { run, transcript } = runtimeFor({ registry, guard });
    await run(
      defineHarness({
        name: "vandal",
        async *run(turn) {
          const part = turn.messages[0]!.parts[0] as { text?: string };
          expect(() => {
            part.text = "I never said this";
          }).toThrow();
          yield { type: "text", delta: "ok" };
        },
      }),
    );
    const stored = await transcript.list({ kind: "user", subject: "u1" }, THREAD);
    expect(JSON.stringify(stored)).toContain("go");
    expect(JSON.stringify(stored)).not.toContain("I never said this");
  });
});

describe("H3 — the seam's payload streams, then settles", () => {
  const APP_VENDO = "/user/apps/app_5/app.vendo";
  const PLAN_VENDO = "/user/apps/app_5/plan.vendo";
  const GOOD = `<App name="X"><Stack><Text value="Hi" /></Stack></App>`;
  const PLAN = `<Plan name="X"><Group title="G"><Leaf component="Table" /></Group></Plan>`;

  it("stamps streaming:true on the skeleton, so a mid-build tree is not read as a finished one", async () => {
    const plan = await viewForWrite(PLAN_VENDO, PLAN, { emit: () => undefined });
    expect((plan?.part.payload as { streaming?: boolean }).streaming).toBe(true);
    const skeletons: boolean[] = [];
    await viewForWrite(APP_VENDO, GOOD, {
      emit: (_id, part) => skeletons.push((part.payload as { streaming?: boolean }).streaming === true),
      authoredApp: async () => undefined,
    });
    expect(skeletons).toEqual([true]);
  });

  it("settles the finished paint, so the app leaves \"building\" and can reach a verdict", async () => {
    const view = await viewForWrite(APP_VENDO, GOOD, { emit: () => undefined });
    expect((view?.part.payload as { streaming?: boolean }).streaming).toBe(false);
  });

  it("awaits the async app half, so the real resolver can wire in", async () => {
    const view = await viewForWrite(APP_VENDO, GOOD, {
      emit: () => undefined,
      authoredApp: async () => ({ data: { rows: [{ id: 1 }] } }),
    });
    expect((view?.part.payload as { data?: unknown }).data).toEqual({ rows: [{ id: 1 }] });
  });
});

describe("H4 — the seam wrapper survives a real façade", () => {
  it("does not break a class that uses private fields", async () => {
    class PrivateFieldFs {
      #files = new Map<string, string>();
      #staged = new Set<string>();
      async writeFile(path: string, content: string): Promise<void> {
        this.#files.set(path, content);
        this.#staged.add(path);
      }
      async readFile(path: string): Promise<string> {
        const found = this.#files.get(path);
        if (found === undefined) throw new Error("ENOENT");
        return found;
      }
      async commit(): Promise<{ status: "ok"; changed: string[] }> {
        const changed = [...this.#staged];
        this.#staged.clear();
        return { status: "ok", changed };
      }
    }
    const emitted: string[] = [];
    const workspace = wrapWorkspaceForRender(new PrivateFieldFs() as never, {
      emit: (id) => emitted.push(id),
    });
    // `this` must be the real object, or every one of these throws
    // "Cannot read private member from an object whose class did not declare it".
    await workspace.writeFile("/user/apps/app_5/app.vendo", `<App name="X"><Stack><Text value="Hi" /></Stack></App>`);
    await expect(workspace.commit()).resolves.toMatchObject({ status: "ok" });
    expect(emitted).toEqual([vendoViewStreamId("app_5")]);
  });
});

describe("C5 — the two consent surfaces a harness turn must still render", () => {
  // Both are wire parity with `createAgent` (§1.6: "a harness turn produces the
  // identical wire a createAgent turn does"). The shipped thread renders each
  // card off the NATIVE ai-SDK tool part — `data-vendo-*` only carries the
  // guard metadata beside it — so a harness that mirrors only its own narrowed
  // `ToolResult` silently drops the card and the user is told nothing.

  it("mirrors a connect-required call as the typed native output the ConnectCard reads", async () => {
    const guard = testGuard();
    const connect = {
      connector: "composio",
      toolkit: "gmail",
      message: "Connect your gmail account to run gmail_send.",
    };
    const registry: ToolRegistry = {
      async descriptors() {
        return [readTool("gmail_send")];
      },
      async execute() {
        return { status: "connect-required", connect };
      },
    };
    const { run } = runtimeFor({ registry, guard });
    const chunks = await run(
      defineHarness({
        name: "mailer",
        async *run(turn) {
          const result = await turn.tools.call("gmail_send", { to: "ada@example.test" });
          // The MODEL still reads a denial with the reason — §1.1's three-status
          // narrowing is deliberate and stays.
          expect(result).toMatchObject({ status: "denied", reason: connect.message });
        },
      }),
    );
    // …but the SCREEN reads the typed outcome off the native part, exactly as it
    // does on the ai-SDK path, or no connect card exists to click.
    const output = chunks.find((chunk) => chunk.type === "tool-output-available");
    expect(output).toMatchObject({ output: { status: "connect-required", connect } });
    expect(chunks.some((chunk) => chunk.type === "tool-output-denied")).toBe(false);
  });

  it("raises the native approval request an interactive parked call needs", async () => {
    const guard = testGuard({ pay: "ask" });
    const registry = boundRegistry(
      { pay: { descriptor: readTool("pay", "destructive"), execute: () => ({ sent: true }) } },
      guard,
    );
    // Nobody taps: the wait lapses. The REQUEST still has to have been raised —
    // that is the card the user never got a chance to see.
    const { run } = runtimeFor({ registry, guard, approvalWaitMs: 30 });
    const chunks = await run(
      defineHarness({
        name: "payer",
        async *run(turn) {
          await turn.tools.call("pay", { amount: 10 });
        },
      }),
    );
    const request = chunks.find((chunk) => chunk.type === "tool-approval-request");
    expect(request).toBeDefined();
    // The id is the GUARD's approval id — the one `approvals.decide` answers and
    // the one the sibling data-vendo-approval part carries.
    const parked = chunks.find((chunk) => chunk.type === "data-vendo-approval");
    expect((parked?.data as { approvalId?: string } | undefined)?.approvalId).toBe(
      (request as { approvalId?: string }).approvalId,
    );
    expect((request as { toolCallId?: string }).toolCallId)
      .toBe((parked?.data as { toolCallId?: string } | undefined)?.toolCallId);
  });
});

describe("C6 — a parked turn keeps its record", () => {
  it("persists the assistant message carrying the parked call, so a reload still shows the card", async () => {
    const guard = testGuard({ pay: "ask" });
    const registry = boundRegistry(
      { pay: { descriptor: readTool("pay", "destructive"), execute: () => ({ sent: true }) } },
      guard,
    );
    // Nobody taps. The turn ends on the wait lapsing — and the transcript must
    // still carry what was asked. A harness turn stays OPEN while it parks, so
    // this is the only save that ever happens for a user who reloads: without it
    // the thread loses the request entirely and the card cannot come back.
    const { run, transcript } = runtimeFor({ registry, guard, approvalWaitMs: 30 });
    await run(
      defineHarness({
        name: "payer",
        async *run(turn) {
          await turn.tools.call("pay", { amount: 10 });
        },
      }),
    );
    const saved = await transcript.list({ kind: "user", subject: "u1" } as never, THREAD);
    const assistant = saved.find((message) => message.role === "assistant");
    expect(assistant).toBeDefined();
    const toolPart = assistant?.parts.find((part) => part.type.startsWith("tool-") || part.type === "dynamic-tool");
    expect(toolPart).toBeDefined();
    expect(assistant?.parts.some((part) => part.type === "data-vendo-approval")).toBe(true);
  });

  it("checkpoints that message WHILE the turn is still parked, not only at turn end", async () => {
    const guard = testGuard({ pay: "ask" });
    const registry = boundRegistry(
      { pay: { descriptor: readTool("pay", "destructive"), execute: () => ({ sent: true }) } },
      guard,
    );
    // The park holds the turn open. A user who reloads during it must still find
    // the card, so the save cannot wait for the turn to end.
    const { run, transcript } = runtimeFor({ registry, guard, approvalWaitMs: 5_000 });
    const finished = run(
      defineHarness({
        name: "payer",
        async *run(turn) {
          await turn.tools.call("pay", { amount: 10 });
        },
      }),
    );
    await vi.waitFor(
      async () => {
        const saved = await transcript.list({ kind: "user", subject: "u1" } as never, THREAD);
        const assistant = saved.find((message) => message.role === "assistant");
        expect(assistant?.parts.some((part) => part.type === "data-vendo-approval")).toBe(true);
      },
      { timeout: 3_000 },
    );
    await finished;
    // …and the finished turn UPDATES that row rather than adding a second copy.
    const saved = await transcript.list({ kind: "user", subject: "u1" } as never, THREAD);
    expect(saved.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  it("checkpoints a SECOND park too — one save per ask, not one per turn", async () => {
    const guard = testGuard({ pay: "ask", wire: "ask" });
    const registry = boundRegistry(
      {
        pay: { descriptor: readTool("pay", "destructive"), execute: () => ({ sent: true }) },
        wire: { descriptor: readTool("wire", "destructive"), execute: () => ({ sent: true }) },
      },
      guard,
    );
    const saves: number[] = [];
    const { run, transcript } = runtimeFor({ registry, guard, approvalWaitMs: 400 });
    const seen = async (): Promise<number> => {
      const rows = await transcript.list({ kind: "user", subject: "u1" } as never, THREAD);
      const assistant = rows.find((message) => message.role === "assistant");
      return (assistant?.parts ?? []).filter((part) => part.type === "data-vendo-approval").length;
    };
    await run(
      defineHarness({
        name: "payer",
        async *run(turn) {
          await turn.tools.call("pay", { amount: 10 });
          saves.push(await seen());
          await turn.tools.call("wire", { amount: 20 });
          saves.push(await seen());
        },
      }),
    );
    // After the first ask the transcript carries one approval; after the second
    // it carries both. A single-shot checkpoint would leave the second at 1.
    expect(saves).toEqual([1, 2]);
  });
});

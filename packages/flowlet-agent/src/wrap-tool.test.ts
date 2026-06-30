import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { tool, type Tool, type ToolExecutionOptions } from "ai";
import { wrapTool } from "./wrap-tool";
import type { ApprovalDecision, ApprovalPolicy } from "./policy";
import { canonicalKey, createInMemoryDecisionStore, rememberDecisions } from "./policy";
import type { ToolDescriptor } from "./descriptor";
import type { FlowletPrincipal } from "./principal";
import { FlowletError } from "./errors";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const principal: FlowletPrincipal = { userId: "u1", roles: ["dev"] };

function descriptorFor(hasExecute: boolean): ToolDescriptor {
  return { name: "t", source: "engine", annotations: {}, hasExecute, kind: "function" };
}

/** A policy whose decision is fixed and synchronous. */
function fixedPolicy(decision: ApprovalDecision): ApprovalPolicy {
  return { evaluate: () => decision };
}

const opts: ToolExecutionOptions = { toolCallId: "call-1", messages: [] };

/**
 * The wrapped tool's `needsApproval` / `execute` are typed as
 * `boolean | fn | undefined` on the SDK `Tool` union, so call them through a
 * narrow cast in tests.
 */
function callNeedsApproval(t: Tool, input: unknown): Promise<boolean> {
  const fn = t.needsApproval as (input: unknown, options: unknown) => boolean | Promise<boolean>;
  return Promise.resolve(fn(input, { toolCallId: "na", messages: [] }));
}

function callExecute(t: Tool, input: unknown, options: ToolExecutionOptions): Promise<unknown> {
  const fn = t.execute as (input: unknown, options: ToolExecutionOptions) => unknown;
  return Promise.resolve(fn(input, options));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wrapTool", () => {
  it("allow: needsApproval is false and execute runs the original", async () => {
    const original = tool({
      description: "x",
      inputSchema: z.object({ v: z.number() }),
      execute: async ({ v }) => `ran:${v}`,
    });
    const w = wrapTool({
      name: "t",
      tool: original,
      descriptor: descriptorFor(true),
      policy: fixedPolicy("allow"),
      principal,
    });

    expect(await callNeedsApproval(w, { v: 1 })).toBe(false);
    expect(await callExecute(w, { v: 1 }, opts)).toBe("ran:1");
  });

  it("approve: needsApproval is true and execute (post-approval) runs the original", async () => {
    const original = tool({
      inputSchema: z.object({ v: z.number() }),
      execute: async ({ v }) => `ran:${v}`,
    });
    const w = wrapTool({
      name: "t",
      tool: original,
      descriptor: descriptorFor(true),
      policy: fixedPolicy("approve"),
      principal,
    });

    expect(await callNeedsApproval(w, { v: 2 })).toBe(true);
    expect(await callExecute(w, { v: 2 }, opts)).toBe("ran:2");
  });

  it("deny: needsApproval is false, execute returns policyDenied, original NEVER runs", async () => {
    const spy = vi.fn(async () => "should-not-run");
    const original = tool({ inputSchema: z.object({ v: z.number() }), execute: spy });
    const w = wrapTool({
      name: "t",
      tool: original,
      descriptor: descriptorFor(true),
      policy: fixedPolicy("deny"),
      principal,
    });

    expect(await callNeedsApproval(w, { v: 1 })).toBe(false);
    const res = await callExecute(w, { v: 1 }, opts);
    expect(res).toMatchObject({ code: "policy_denied", tool: "t" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("execute is authoritative across the turn (fresh instance, no shared cache)", async () => {
    // deny still blocks even though needsApproval was never called this turn.
    const denySpy = vi.fn(async () => "ok");
    const wDeny = wrapTool({
      name: "t",
      tool: tool({ inputSchema: z.object({}), execute: denySpy }),
      descriptor: descriptorFor(true),
      policy: fixedPolicy("deny"),
      principal,
    });
    expect(await callExecute(wDeny, {}, opts)).toMatchObject({ code: "policy_denied" });
    expect(denySpy).not.toHaveBeenCalled();

    // allow still runs.
    const allowSpy = vi.fn(async () => "ok");
    const wAllow = wrapTool({
      name: "t",
      tool: tool({ inputSchema: z.object({}), execute: allowSpy }),
      descriptor: descriptorFor(true),
      policy: fixedPolicy("allow"),
      principal,
    });
    expect(await callExecute(wAllow, {}, opts)).toBe("ok");
    expect(allowSpy).toHaveBeenCalledOnce();
  });

  it("preserves all SDK fields, overriding only needsApproval/execute/toModelOutput", () => {
    const toModelOutput = () => ({ type: "text" as const, value: "x" });
    const original = {
      type: "function",
      inputSchema: z.object({ v: z.number() }),
      outputSchema: z.string(),
      title: "My Tool",
      providerOptions: { foo: { bar: "baz" } },
      execute: async () => "ok",
      toModelOutput,
      customField: 123,
    } as unknown as Tool;

    const w = wrapTool({
      name: "t",
      tool: original,
      descriptor: descriptorFor(true),
      policy: fixedPolicy("allow"),
      principal,
    });

    expect(w.inputSchema).toBe(original.inputSchema);
    expect((w as { outputSchema?: unknown }).outputSchema).toBe(
      (original as { outputSchema?: unknown }).outputSchema,
    );
    expect(w.title).toBe("My Tool");
    expect(w.providerOptions).toEqual({ foo: { bar: "baz" } });
    expect((w as unknown as { customField: number }).customField).toBe(123);
    expect((w as { type?: string }).type).toBe("function");
    // overridden:
    expect(w.needsApproval).not.toBe(original.needsApproval);
    expect(w.execute).not.toBe(original.execute);
    // toModelOutput is now wrapped (deny-payload guard), but delegates normal
    // outputs to the original.
    expect(w.toModelOutput).not.toBe(toModelOutput);
    expect(
      (w.toModelOutput as (o: unknown) => unknown)({
        toolCallId: "c",
        input: {},
        output: "normal",
      }),
    ).toEqual({ type: "text", value: "x" });
  });

  it("when the original has no toModelOutput, the wrapped tool has none either (SDK default)", () => {
    const original = tool({
      inputSchema: z.object({ v: z.number() }),
      execute: async () => "ok",
    });
    const w = wrapTool({
      name: "t",
      tool: original,
      descriptor: descriptorFor(true),
      policy: fixedPolicy("allow"),
      principal,
    });
    expect(w.toModelOutput).toBeUndefined();
  });

  it("deny + custom toModelOutput: denial is converted to text and the original is NOT called", async () => {
    const toModelOutput = vi.fn(() => ({ type: "text" as const, value: "original" }));
    const original = {
      type: "function",
      inputSchema: z.object({ v: z.number() }),
      execute: vi.fn(async () => "real-output"),
      toModelOutput,
    } as unknown as Tool;

    const w = wrapTool({
      name: "t",
      tool: original,
      descriptor: descriptorFor(true),
      policy: fixedPolicy("deny"),
      principal,
    });

    const denyPayload = await callExecute(w, { v: 1 }, opts);
    expect(denyPayload).toMatchObject({ code: "policy_denied", tool: "t" });

    // The SDK would feed the execute result into toModelOutput. The wrapped
    // toModelOutput must safely convert the deny payload to text and NOT
    // delegate the deny payload to the original toModelOutput.
    const modelOutput = (w.toModelOutput as (o: unknown) => unknown)({
      toolCallId: "c",
      input: { v: 1 },
      output: denyPayload,
    });
    expect(modelOutput).toMatchObject({ type: "text" });
    expect((modelOutput as { value: string }).value).toContain("t");
    expect(toModelOutput).not.toHaveBeenCalled();
  });

  it("onExecuted: fires after a successful allow execute with the context AND the 'allow' decision", async () => {
    const onExecuted = vi.fn();
    const policy: ApprovalPolicy = { evaluate: () => "allow", onExecuted };
    const w = wrapTool({
      name: "t",
      tool: tool({ inputSchema: z.object({ v: z.number() }), execute: async () => "ok" }),
      descriptor: descriptorFor(true),
      policy,
      principal,
    });

    expect(await callExecute(w, { v: 7 }, opts)).toBe("ok");
    expect(onExecuted).toHaveBeenCalledOnce();
    expect(onExecuted).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "t", input: { v: 7 }, principal }),
      "allow",
    );
  });

  it("onExecuted: fires after a successful approve execute with the 'approve' decision", async () => {
    const onExecuted = vi.fn();
    const policy: ApprovalPolicy = { evaluate: () => "approve", onExecuted };
    const w = wrapTool({
      name: "t",
      tool: tool({ inputSchema: z.object({ v: z.number() }), execute: async () => "ok" }),
      descriptor: descriptorFor(true),
      policy,
      principal,
    });

    expect(await callExecute(w, { v: 9 }, opts)).toBe("ok");
    expect(onExecuted).toHaveBeenCalledOnce();
    expect(onExecuted).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "t", input: { v: 9 }, principal }),
      "approve",
    );
  });

  it("onExecuted: NOT fired for a deny decision (tool never ran)", async () => {
    const onExecuted = vi.fn();
    const spy = vi.fn(async () => "should-not-run");
    const policy: ApprovalPolicy = { evaluate: () => "deny", onExecuted };
    const w = wrapTool({
      name: "t",
      tool: tool({ inputSchema: z.object({ v: z.number() }), execute: spy }),
      descriptor: descriptorFor(true),
      policy,
      principal,
    });

    await callExecute(w, { v: 1 }, opts);
    expect(spy).not.toHaveBeenCalled();
    expect(onExecuted).not.toHaveBeenCalled();
  });

  it("onExecuted: NOT fired when the real execute throws", async () => {
    const onExecuted = vi.fn();
    const policy: ApprovalPolicy = { evaluate: () => "allow", onExecuted };
    const w = wrapTool({
      name: "t",
      tool: tool({
        inputSchema: z.object({}),
        execute: async () => {
          throw new Error("boom");
        },
      }),
      descriptor: descriptorFor(true),
      policy,
      principal,
    });

    await expect(callExecute(w, {}, opts)).rejects.toThrow("boom");
    expect(onExecuted).not.toHaveBeenCalled();
  });

  it("integration: rememberDecisions records on execute and suppresses the next prompt", async () => {
    const store = createInMemoryDecisionStore();
    const spy = vi.fn(async () => "ran");
    const policy = rememberDecisions(fixedPolicy("approve"), store);
    const input = { v: 1 };
    const w = wrapTool({
      name: "t",
      tool: tool({ inputSchema: z.object({ v: z.number() }), execute: spy }),
      descriptor: descriptorFor(true),
      policy,
      principal,
    });

    // Ask turn: needs approval, nothing recorded yet.
    expect(await callNeedsApproval(w, input)).toBe(true);
    const key = canonicalKey(
      { toolName: "t", input, descriptor: descriptorFor(true), principal },
      "v1",
    );
    expect(await store.get(key)).toBeUndefined();

    // Execute turn (post-approval): runs the tool AND records via onExecuted.
    expect(await callExecute(w, input, opts)).toBe("ran");
    expect(spy).toHaveBeenCalledOnce();
    expect(await store.get(key)).toBe("approve");

    // Next identical call no longer needs approval (suppressed).
    expect(await callNeedsApproval(w, input)).toBe(false);
  });

  it("integration: a deny decision does NOT record and does NOT run the tool", async () => {
    const store = createInMemoryDecisionStore();
    const spy = vi.fn(async () => "ran");
    const policy = rememberDecisions(fixedPolicy("deny"), store);
    const input = { v: 1 };
    const w = wrapTool({
      name: "t",
      tool: tool({ inputSchema: z.object({ v: z.number() }), execute: spy }),
      descriptor: descriptorFor(true),
      policy,
      principal,
    });

    const res = await callExecute(w, input, opts);
    expect(res).toMatchObject({ code: "policy_denied", tool: "t" });
    expect(spy).not.toHaveBeenCalled();
    const key = canonicalKey(
      { toolName: "t", input, descriptor: descriptorFor(true), principal },
      "v1",
    );
    expect(await store.get(key)).toBeUndefined();
  });

  it("execute re-evaluates the composed policy: a policy that flips allow→deny between needsApproval and execute is enforced (deny), original NEVER runs", async () => {
    // BLOCKER 1 regression: the SDK calls needsApproval (preflight) then, in a
    // later turn, execute. A mutable policy whose state changed between the two
    // (returns "allow" first, "deny" second) MUST be re-evaluated at execute
    // time and the now-denied call blocked — no stale cached "allow".
    let call = 0;
    const policy: ApprovalPolicy = {
      evaluate: () => (++call === 1 ? "allow" : "deny"),
    };
    const spy = vi.fn(async () => "should-not-run");
    const w = wrapTool({
      name: "t",
      tool: tool({ inputSchema: z.object({ v: z.number() }), execute: spy }),
      descriptor: descriptorFor(true),
      policy,
      principal,
    });

    // Preflight (call #1): allow → no approval needed.
    expect(await callNeedsApproval(w, { v: 1 })).toBe(false);
    // Execute (call #2): policy now denies → must block, original never runs.
    const res = await callExecute(w, { v: 1 }, opts);
    expect(res).toMatchObject({ code: "policy_denied", tool: "t" });
    expect(spy).not.toHaveBeenCalled();
    expect(call).toBe(2); // policy evaluated fresh on BOTH callbacks
  });

  it("throws FlowletError('policy', ...) when wrapping a no-execute tool", () => {
    const noExec = { inputSchema: z.object({}) } as unknown as Tool;
    let thrown: unknown;
    try {
      wrapTool({
        name: "noexec",
        tool: noExec,
        descriptor: descriptorFor(false),
        policy: fixedPolicy("allow"),
        principal,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FlowletError);
    expect((thrown as FlowletError).code).toBe("policy");
    expect((thrown as FlowletError).message).toContain("noexec");
  });

  it("forwards options (incl. abortSignal) through to the original execute", async () => {
    let seen: ToolExecutionOptions | undefined;
    const original = tool({
      inputSchema: z.object({}),
      execute: async (_input, options) => {
        seen = options;
        return "ok";
      },
    });
    const w = wrapTool({
      name: "t",
      tool: original,
      descriptor: descriptorFor(true),
      policy: fixedPolicy("allow"),
      principal,
    });

    const ac = new AbortController();
    const passed: ToolExecutionOptions = {
      toolCallId: "call-9",
      messages: [],
      abortSignal: ac.signal,
    };
    await callExecute(w, {}, passed);

    expect(seen).toBe(passed);
    expect(seen?.abortSignal).toBe(ac.signal);
  });

  it("execute evaluates per-input: an allow input runs while a deny input is blocked (no cross-input leak)", async () => {
    // Policy: allow for { v: 1 }, deny for everything else.
    const spy = vi.fn(async () => "ran");
    const policy: ApprovalPolicy = {
      evaluate: (ctx) => ((ctx.input as { v: number }).v === 1 ? "allow" : "deny"),
    };
    const w = wrapTool({
      name: "t",
      tool: tool({ inputSchema: z.object({ v: z.number() }), execute: spy }),
      descriptor: descriptorFor(true),
      policy,
      principal,
    });

    // Allow input runs.
    expect(await callExecute(w, { v: 1 }, opts)).toBe("ran");
    expect(spy).toHaveBeenCalledOnce();
    // Different input is denied independently (each execute evaluates fresh).
    const res = await callExecute(w, { v: 2 }, opts);
    expect(res).toMatchObject({ code: "policy_denied", tool: "t" });
    expect(spy).toHaveBeenCalledOnce(); // deny input never ran the original
  });

  it("deny path reports cleanly under a non-object outputSchema (no crash)", async () => {
    // The tool declares a string outputSchema; the deny payload is an object.
    // ai@6.0.28 does NOT validate an execute return against outputSchema in the
    // live run path (only the opt-in validateUIMessages utility does), so the
    // object return is reported as a normal tool result without crashing.
    const spy = vi.fn(async () => "real-output");
    const w = wrapTool({
      name: "t",
      tool: tool({
        inputSchema: z.object({ v: z.number() }),
        outputSchema: z.string(),
        execute: spy,
      }),
      descriptor: descriptorFor(true),
      policy: fixedPolicy("deny"),
      principal,
    });

    let res: unknown;
    await expect(
      (async () => {
        res = await callExecute(w, { v: 1 }, opts);
      })(),
    ).resolves.not.toThrow();
    expect(res).toMatchObject({ code: "policy_denied", tool: "t" });
    expect(spy).not.toHaveBeenCalled();
  });
});

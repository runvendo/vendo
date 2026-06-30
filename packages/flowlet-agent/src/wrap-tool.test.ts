import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { tool, type Tool, type ToolExecutionOptions } from "ai";
import { wrapTool } from "./wrap-tool";
import type { ApprovalDecision, ApprovalPolicy } from "./policy";
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

  it("preserves all SDK fields, overriding only needsApproval/execute", () => {
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
    expect(w.toModelOutput).toBe(toModelOutput);
    expect((w as unknown as { customField: number }).customField).toBe(123);
    expect((w as { type?: string }).type).toBe("function");
    // overridden:
    expect(w.needsApproval).not.toBe(original.needsApproval);
    expect(w.execute).not.toBe(original.execute);
  });

  it("decisionCache: same input evaluates the policy once; a different input re-evaluates", async () => {
    const evalSpy = vi.fn((): ApprovalDecision => "allow");
    const policy: ApprovalPolicy = { evaluate: evalSpy };
    const cache = new Map<string, ApprovalDecision>();
    const w = wrapTool({
      name: "t",
      tool: tool({ inputSchema: z.object({ v: z.number() }), execute: async () => "ok" }),
      descriptor: descriptorFor(true),
      policy,
      principal,
      decisionCache: cache,
    });

    await callNeedsApproval(w, { v: 1 });
    await callExecute(w, { v: 1 }, opts);
    expect(evalSpy).toHaveBeenCalledTimes(1); // cache hit on the second call

    await callNeedsApproval(w, { v: 2 });
    expect(evalSpy).toHaveBeenCalledTimes(2); // different input → fresh eval
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

  it("warm cache cannot let a denied call through (deny + decisionCache)", async () => {
    // needsApproval runs first and populates the cache with "deny"; the
    // approval-gap `execute` reads that same cached "deny" and must still block.
    const spy = vi.fn(async () => "should-not-run");
    const cache = new Map<string, ApprovalDecision>();
    const w = wrapTool({
      name: "t",
      tool: tool({ inputSchema: z.object({ v: z.number() }), execute: spy }),
      descriptor: descriptorFor(true),
      policy: fixedPolicy("deny"),
      principal,
      decisionCache: cache,
    });

    expect(await callNeedsApproval(w, { v: 1 })).toBe(false); // populates cache
    const res = await callExecute(w, { v: 1 }, opts);
    expect(res).toMatchObject({ code: "policy_denied", tool: "t" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("shared cache does not leak one input's allow onto another input's deny", async () => {
    // Policy: allow for { v: 1 }, deny for everything else.
    const spy = vi.fn(async () => "should-not-run");
    const policy: ApprovalPolicy = {
      evaluate: (ctx) => ((ctx.input as { v: number }).v === 1 ? "allow" : "deny"),
    };
    const cache = new Map<string, ApprovalDecision>();
    const w = wrapTool({
      name: "t",
      tool: tool({ inputSchema: z.object({ v: z.number() }), execute: spy }),
      descriptor: descriptorFor(true),
      policy,
      principal,
      decisionCache: cache,
    });

    // Cache "allow" for input A.
    expect(await callNeedsApproval(w, { v: 1 })).toBe(false);
    // Different input B must still be denied (no cross-key leak).
    const res = await callExecute(w, { v: 2 }, opts);
    expect(res).toMatchObject({ code: "policy_denied", tool: "t" });
    expect(spy).not.toHaveBeenCalled();
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

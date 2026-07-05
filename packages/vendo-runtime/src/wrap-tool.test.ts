import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { tool, type Tool, type ToolExecutionOptions } from "ai";
import { wrapTool } from "./wrap-tool";
import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./policy";
import { grantPolicy, hashInput } from "./policy";
import { createInMemoryGrantStore } from "./grant-store";
import { hashDescriptor } from "./automations/grants";
import { createRunPolicyContext } from "./policy/run-context";
import { setEscalationReason } from "./policy/escalation";
import type { ToolDescriptor } from "./descriptor";
import type { VendoPrincipal } from "./principal";
import { VendoError } from "./errors";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const principal: VendoPrincipal = { userId: "u1", roles: ["dev"] };

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
 *
 * Default toolCallId matches `opts.toolCallId` below ("call-1") — in the real
 * SDK, `needsApproval` and `execute` for the SAME call always share one
 * toolCallId (that correlation is what wrap-tool.ts's fail-closed pause
 * tracking relies on); tests that exercise that correlation pass an explicit
 * id instead.
 */
function callNeedsApproval(t: Tool, input: unknown, toolCallId = "call-1"): Promise<boolean> {
  const fn = t.needsApproval as (input: unknown, options: unknown) => boolean | Promise<boolean>;
  return Promise.resolve(fn(input, { toolCallId, messages: [] }));
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

    // A real "approve" execute always follows a needsApproval pause the
    // human resolved (same toolCallId as `opts`, ENG-193 review item 3).
    await callNeedsApproval(w, { v: 9 });
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

  it("integration: an exact-scope grant suppresses the re-prompt for a matching input only", async () => {
    const store = createInMemoryGrantStore();
    const spy = vi.fn(async () => "ran");
    const descriptor = descriptorFor(true);
    const input = { v: 1 };
    const grantScope = { tenantId: "t", subject: principal.userId };
    await store.create(grantScope, {
      tool: "t",
      descriptorHash: hashDescriptor(descriptor),
      scope: { kind: "exact", inputHash: hashInput(input), inputPreview: "v:1" },
      duration: "standing",
      source: { kind: "fade" },
    });
    const policy = grantPolicy(fixedPolicy("approve"), store, {
      principalScope: () => grantScope,
    });
    const w = wrapTool({
      name: "t",
      tool: tool({ inputSchema: z.object({ v: z.number() }), execute: spy }),
      descriptor,
      policy,
      principal,
    });

    // Matching input is suppressed by the seeded grant — no approval needed.
    expect(await callNeedsApproval(w, input)).toBe(false);
    expect(await callExecute(w, input, opts)).toBe("ran");
    expect(spy).toHaveBeenCalledOnce();

    // A different input is outside the exact grant's scope — still prompts.
    expect(await callNeedsApproval(w, { v: 2 })).toBe(true);
  });

  it("integration: a deny decision still denies and does NOT run the tool despite a matching grant", async () => {
    const store = createInMemoryGrantStore();
    const spy = vi.fn(async () => "ran");
    const descriptor = descriptorFor(true);
    const input = { v: 1 };
    const grantScope = { tenantId: "t", subject: principal.userId };
    await store.create(grantScope, {
      tool: "t",
      descriptorHash: hashDescriptor(descriptor),
      scope: { kind: "exact", inputHash: hashInput(input), inputPreview: "v:1" },
      duration: "standing",
      source: { kind: "fade" },
    });
    const policy = grantPolicy(fixedPolicy("deny"), store, {
      principalScope: () => grantScope,
    });
    const w = wrapTool({
      name: "t",
      tool: tool({ inputSchema: z.object({ v: z.number() }), execute: spy }),
      descriptor,
      policy,
      principal,
    });

    const res = await callExecute(w, input, opts);
    expect(res).toMatchObject({ code: "policy_denied", tool: "t" });
    expect(spy).not.toHaveBeenCalled();
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

  describe("REVIEW FOLLOW-UP: execute fails closed on an allow→approve escalation (no human ever paused for this call)", () => {
    it("a policy that escalates allow→approve between needsApproval and execute is refused at execute time with 'approval_required' — the real tool is NEVER called", async () => {
      // Unlike the allow→deny flip above, "approve" is not a hard refusal —
      // it means a human needs to look. But the SDK only calls execute AFTER
      // a human approved an "approve" needsApproval outcome; here
      // needsApproval saw "allow" (no pause), so execute's fresh "approve" is
      // an ESCALATION no human has ever seen. Fail closed rather than run it.
      let call = 0;
      const policy: ApprovalPolicy = {
        evaluate: () => (++call === 1 ? "allow" : "approve"),
      };
      const spy = vi.fn(async () => "should-not-run");
      const w = wrapTool({
        name: "t",
        tool: tool({ inputSchema: z.object({ v: z.number() }), execute: spy }),
        descriptor: descriptorFor(true),
        policy,
        principal,
      });

      // Preflight (call #1): allow → no pause, no approval requested.
      expect(await callNeedsApproval(w, { v: 1 })).toBe(false);
      // Execute (call #2, SAME toolCallId "call-1" via `opts`): policy now
      // says "approve" — but no pause was ever recorded for this call.
      const res = await callExecute(w, { v: 1 }, opts);
      expect(res).toMatchObject({ code: "approval_required", tool: "t" });
      expect(spy).not.toHaveBeenCalled();
      expect(call).toBe(2); // policy evaluated fresh on BOTH callbacks
    });

    it("the normal approve → human-approves → execute flow still executes (a real pause WAS recorded for this toolCallId)", async () => {
      const spy = vi.fn(async () => "ran");
      const w = wrapTool({
        name: "t",
        tool: tool({ inputSchema: z.object({ v: z.number() }), execute: spy }),
        descriptor: descriptorFor(true),
        policy: fixedPolicy("approve"),
        principal,
      });

      // needsApproval and execute share the SAME toolCallId ("call-1", via
      // the helper defaults / `opts`) — exactly like the real SDK turn pair.
      expect(await callNeedsApproval(w, { v: 2 })).toBe(true);
      expect(await callExecute(w, { v: 2 }, opts)).toBe("ran");
      expect(spy).toHaveBeenCalledOnce();
    });

    it("a DIFFERENT toolCallId's escalation doesn't borrow another call's recorded pause", async () => {
      let call = 0;
      const policy: ApprovalPolicy = {
        evaluate: () => (++call === 1 ? "allow" : "approve"),
      };
      const spy = vi.fn(async () => "should-not-run");
      const w = wrapTool({
        name: "t",
        tool: tool({ inputSchema: z.object({ v: z.number() }), execute: spy }),
        descriptor: descriptorFor(true),
        policy,
        principal,
      });

      // A DIFFERENT toolCallId ("other-call") genuinely paused earlier.
      expect(await callNeedsApproval(w, { v: 9 }, "other-call")).toBe(false); // decision "allow" here (call #1) — no pause recorded for it either
      // This toolCallId ("call-1") never had its own needsApproval pause.
      const res = await callExecute(w, { v: 1 }, opts);
      expect(res).toMatchObject({ code: "approval_required", tool: "t" });
      expect(spy).not.toHaveBeenCalled();
    });

    it("deny still wins over the escalation check (deny is checked first, regardless of pause state)", async () => {
      const spy = vi.fn(async () => "should-not-run");
      const w = wrapTool({
        name: "t",
        tool: tool({ inputSchema: z.object({ v: z.number() }), execute: spy }),
        descriptor: descriptorFor(true),
        policy: fixedPolicy("deny"),
        principal,
      });
      const res = await callExecute(w, { v: 1 }, opts);
      expect(res).toMatchObject({ code: "policy_denied", tool: "t" });
      expect(spy).not.toHaveBeenCalled();
    });

    it("onExecuted is NOT called when execute refuses on the approval_required path", async () => {
      const onExecuted = vi.fn();
      let call = 0;
      const policy: ApprovalPolicy = {
        evaluate: () => (++call === 1 ? "allow" : "approve"),
        onExecuted,
      };
      const spy = vi.fn(async () => "should-not-run");
      const w = wrapTool({
        name: "t",
        tool: tool({ inputSchema: z.object({ v: z.number() }), execute: spy }),
        descriptor: descriptorFor(true),
        policy,
        principal,
      });
      await callNeedsApproval(w, { v: 1 });
      await callExecute(w, { v: 1 }, opts);
      expect(onExecuted).not.toHaveBeenCalled();
    });
  });

  it("throws VendoError('policy', ...) when wrapping a no-execute tool", () => {
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
    expect(thrown).toBeInstanceOf(VendoError);
    expect((thrown as VendoError).code).toBe("policy");
    expect((thrown as VendoError).message).toContain("noexec");
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

  it("writes ONE data-consent part at needsApproval time for a non-read tool, decision 'approve'", async () => {
    const writes: unknown[] = [];
    const writer = { write: (part: unknown) => writes.push(part) } as never;
    const descriptor: ToolDescriptor = {
      name: "send_email", source: "caller",
      annotations: { readOnlyHint: false }, hasExecute: true, kind: "function",
    };
    const wrapped = wrapTool({
      name: "send_email",
      tool: { execute: async () => "ok" } as unknown as Tool,
      descriptor, policy: fixedPolicy("approve"), principal, writer,
    });
    await wrapped.needsApproval!({}, { toolCallId: "call-1", messages: [] } as never);
    expect(writes).toEqual([
      { type: "data-consent", id: "consent-call-1", data: { toolCallId: "call-1", tier: "act", unverified: false } },
    ]);
  });

  it("writes the data-consent part even when the decision is 'allow' (receipts, Moment 2)", async () => {
    const writes: unknown[] = [];
    const writer = { write: (part: unknown) => writes.push(part) } as never;
    const descriptor: ToolDescriptor = {
      name: "send_email", source: "caller",
      annotations: { readOnlyHint: false }, hasExecute: true, kind: "function",
    };
    const wrapped = wrapTool({
      name: "send_email",
      tool: { execute: async () => "ok" } as unknown as Tool,
      descriptor, policy: fixedPolicy("allow"), principal, writer,
    });
    await wrapped.needsApproval!({}, { toolCallId: "call-2", messages: [] } as never);
    expect(writes).toHaveLength(1);
    expect((writes[0] as { data: { tier: string } }).data.tier).toBe("act");
  });

  it("writes NOTHING for a read-tier tool", async () => {
    const writes: unknown[] = [];
    const writer = { write: (part: unknown) => writes.push(part) } as never;
    const descriptor: ToolDescriptor = {
      name: "get_x", source: "caller",
      annotations: { readOnlyHint: true }, hasExecute: true, kind: "function",
    };
    const wrapped = wrapTool({
      name: "get_x", tool: { execute: async () => "ok" } as unknown as Tool,
      descriptor, policy: fixedPolicy("allow"), principal, writer,
    });
    await wrapped.needsApproval!({}, { toolCallId: "call-3", messages: [] } as never);
    expect(writes).toHaveLength(0);
  });

  it("works with no writer at all (no card client, no crash)", async () => {
    const descriptor: ToolDescriptor = {
      name: "send_email", source: "caller",
      annotations: { readOnlyHint: false }, hasExecute: true, kind: "function",
    };
    const wrapped = wrapTool({
      name: "send_email", tool: { execute: async () => "ok" } as unknown as Tool,
      descriptor, policy: fixedPolicy("approve"), principal,
    });
    await expect(wrapped.needsApproval!({}, { toolCallId: "call-4", messages: [] } as never)).resolves.toBe(true);
  });

  it("a throwing writer still resolves needsApproval normally (consent write must never break the tool call)", async () => {
    const writer = {
      write: () => {
        throw new Error("stream torn down");
      },
    } as never;
    const descriptor: ToolDescriptor = {
      name: "send_email", source: "caller",
      annotations: { readOnlyHint: false }, hasExecute: true, kind: "function",
    };
    const wrapped = wrapTool({
      name: "send_email", tool: { execute: async () => "ok" } as unknown as Tool,
      descriptor, policy: fixedPolicy("approve"), principal, writer,
    });
    await expect(
      wrapped.needsApproval!({}, { toolCallId: "call-5", messages: [] } as never),
    ).resolves.toBe(true);
  });

  it("threads request/provenance/counters from a RunPolicyContext into evaluate", async () => {
    const seen: PolicyContext[] = [];
    const spyPolicy: ApprovalPolicy = { evaluate: (ctx) => { seen.push(ctx); return "allow"; } };
    const runContext = createRunPolicyContext({ text: "email jim", messageId: "m1" });
    const original = tool({ inputSchema: z.object({}), execute: async () => "ok" });
    const w = wrapTool({
      name: "send_email",
      tool: original,
      descriptor: { name: "send_email", source: "caller", annotations: { readOnlyHint: false }, hasExecute: true, kind: "function" },
      policy: spyPolicy,
      principal,
      runContext,
    });
    await callNeedsApproval(w, {});
    expect(seen[0]!.request).toEqual({ text: "email jim", messageId: "m1" });
    expect(seen[0]!.counters).toEqual({ toolCallsThisTurn: 1, perTool: { send_email: 1 } });
    expect(seen[0]!.provenance).toEqual({ taintedSources: [] });
  });

  it("recordResult taints the run AFTER a genuine execute (not before, not on deny)", async () => {
    const runContext = createRunPolicyContext();
    const openWorldDesc: ToolDescriptor = {
      name: "GMAIL_FETCH", source: "composio", annotations: { openWorldHint: true }, hasExecute: true, kind: "function",
    };
    const original = tool({ inputSchema: z.object({}), execute: async () => "results" });
    const w = wrapTool({ name: "GMAIL_FETCH", tool: original, descriptor: openWorldDesc, policy: fixedPolicy("allow"), principal, runContext });
    expect(runContext.snapshotProvenance()).toEqual({ taintedSources: [] });
    await callExecute(w, {}, opts);
    expect(runContext.snapshotProvenance()).toEqual({ taintedSources: ["GMAIL_FETCH"] });
  });

  it("writes the escalation reason onto the data-consent part when the policy stamped one", async () => {
    const writes: unknown[] = [];
    const writer = { write: (part: unknown) => writes.push(part) } as never;
    const descriptor: ToolDescriptor = {
      name: "send_email", source: "caller", annotations: { readOnlyHint: false }, hasExecute: true, kind: "function",
    };
    // A policy that BOTH decides "approve" AND stamps a reason on the ctx it received.
    const reasonPolicy: ApprovalPolicy = {
      evaluate(ctx) {
        setEscalationReason(ctx, "an email I read asked for this");
        return "approve";
      },
    };
    const w = wrapTool({ name: "send_email", tool: { execute: async () => "ok" } as unknown as Tool, descriptor, policy: reasonPolicy, principal, writer });
    await callNeedsApproval(w, {});
    expect(writes).toEqual([
      { type: "data-consent", id: "consent-call-1", data: { toolCallId: "call-1", tier: "act", unverified: false, reason: "an email I read asked for this" } },
    ]);
  });
});

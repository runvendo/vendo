import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import {
  createInMemoryCompiledRuleStore,
  createInMemoryGrantStore,
  InMemoryAuditLog,
  type ApprovalPolicy,
} from "@flowlet/runtime";
import { createApprovalStore, handleAction, type ActionDeps } from "./action";
import { defaultFlowletPolicy } from "./default-policy";
import { composeProductionPolicy } from "./policy-stack";

function actionReq(body: unknown, host = "localhost:3000"): Request {
  return new Request(`http://${host}/api/flowlet/action`, {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deps(overrides: Partial<ActionDeps> = {}): ActionDeps {
  const readTool = {
    ...tool({
      description: "read things",
      inputSchema: z.object({}).passthrough(),
      execute: async () => ({ things: [1, 2] }),
    }),
    annotations: { readOnlyHint: true },
  };
  const writeTool = tool({
    description: "write things",
    inputSchema: z.object({ amount: z.number() }).passthrough(),
    execute: async (input: unknown) => ({ wrote: input }),
  });
  return {
    getTools: () => ({ get_things: readTool, create_thing: writeTool }),
    policy: defaultFlowletPolicy,
    approvals: createApprovalStore(),
    options: {},
    ...overrides,
  };
}

describe("handleAction", () => {
  it("executes an annotated read directly", async () => {
    const res = await handleAction(actionReq({ action: "get_things" }), deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decision: "allow", result: { things: [1, 2] } });
  });

  it("gates an unannotated tool behind an approval token, then executes", async () => {
    const d = deps();
    const first = await handleAction(
      actionReq({ action: "create_thing", payload: { amount: 5 } }),
      d,
    );
    const gate = (await first.json()) as { needsApproval: boolean; approvalToken: string };
    expect(gate.needsApproval).toBe(true);
    expect(gate.approvalToken).toBeTruthy();

    const second = await handleAction(
      actionReq({ action: "create_thing", payload: { amount: 5 }, approvalToken: gate.approvalToken }),
      d,
    );
    expect((await second.json()).result).toEqual({ wrote: { amount: 5 } });
  });

  it("rejects a token bound to a different payload and burns it", async () => {
    const d = deps();
    const first = await handleAction(
      actionReq({ action: "create_thing", payload: { amount: 5 } }),
      d,
    );
    const { approvalToken } = (await first.json()) as { approvalToken: string };

    // Tampered payload: token must not authorize it — we get a fresh gate.
    const tampered = await handleAction(
      actionReq({ action: "create_thing", payload: { amount: 5_000 }, approvalToken }),
      d,
    );
    expect(((await tampered.json()) as { needsApproval?: boolean }).needsApproval).toBe(true);

    // The token is single-use: replaying it with the ORIGINAL payload fails too.
    const replay = await handleAction(
      actionReq({ action: "create_thing", payload: { amount: 5 }, approvalToken }),
      d,
    );
    expect(((await replay.json()) as { needsApproval?: boolean }).needsApproval).toBe(true);
  });

  it("rejects a forged token", async () => {
    const res = await handleAction(
      actionReq({ action: "create_thing", payload: {}, approvalToken: "made-up" }),
      deps(),
    );
    expect(((await res.json()) as { needsApproval?: boolean }).needsApproval).toBe(true);
  });

  it("404s an unknown action and 400s a missing one", async () => {
    const d = deps();
    // unknown action: still policy-evaluated (approve) — approve+token path
    // first; an unknown name with a valid token 404s instead of executing.
    const first = await handleAction(actionReq({ action: "nope" }), d);
    const { approvalToken } = (await first.json()) as { approvalToken: string };
    const second = await handleAction(actionReq({ action: "nope", approvalToken }), d);
    expect(second.status).toBe(404);

    expect((await handleAction(actionReq({}), d)).status).toBe(400);
  });

  it("blocks remote requests", async () => {
    const res = await handleAction(
      actionReq({ action: "get_things" }, "myapp.example.com"),
      deps(),
    );
    expect(res.status).toBe(403);
  });

  describe("REVIEW FOLLOW-UP: policy.onExecuted", () => {
    it("fires after a successful dispatch, with the same ctx and the enforced decision — the Trust diary/breaker counting was otherwise blind to /action dispatches", async () => {
      const calls: { toolName: string; toolCallId: string | undefined; decision: string }[] = [];
      const policy: ApprovalPolicy = {
        evaluate: () => "allow",
        onExecuted: (ctx, decision) => {
          calls.push({ toolName: ctx.toolName, toolCallId: ctx.toolCallId, decision });
        },
      };
      const res = await handleAction(actionReq({ action: "get_things" }), deps({ policy }));
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ toolName: "get_things", decision: "allow" });
      expect(calls[0]?.toolCallId).toBeTruthy();
    });

    it("fires with the 'approve' decision once a gated action's token is confirmed and it actually executes", async () => {
      const calls: string[] = [];
      const policy: ApprovalPolicy = {
        evaluate: () => "approve",
        onExecuted: (_ctx, decision) => { calls.push(decision); },
      };
      const d = deps({ policy });
      const first = await handleAction(actionReq({ action: "create_thing", payload: { amount: 5 } }), d);
      const { approvalToken } = (await first.json()) as { approvalToken: string };
      expect(calls).toHaveLength(0); // gating alone never counts as executed

      const second = await handleAction(
        actionReq({ action: "create_thing", payload: { amount: 5 }, approvalToken }),
        d,
      );
      expect(second.status).toBe(200);
      expect(calls).toEqual(["approve"]);
    });

    it("never fires on a deny (the tool never ran)", async () => {
      const calls: unknown[] = [];
      const policy: ApprovalPolicy = { evaluate: () => "deny", onExecuted: (...args) => { calls.push(args); } };
      const res = await handleAction(actionReq({ action: "get_things" }), deps({ policy }));
      expect(res.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it("wired through the REAL composed production policy: a successful dispatch leaves a tool_execution audit event (the composed auditPolicy writes it via onExecuted)", async () => {
      const audit = new InMemoryAuditLog();
      const policy = composeProductionPolicy(defaultFlowletPolicy, {
        grants: createInMemoryGrantStore(),
        rules: createInMemoryCompiledRuleStore(),
        audit,
      });
      const res = await handleAction(actionReq({ action: "get_things" }), deps({ policy }));
      expect(res.status).toBe(200);
      const scope = { tenantId: "flowlet-embedded", subject: "flowlet-default-user" };
      const events = await audit.query(scope, { kinds: ["tool_execution"] });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ toolName: "get_things", outcome: "ok" });
    });

    it("never fires when the real execute throws", async () => {
      const throwingTool = tool({
        description: "boom",
        inputSchema: z.object({}).passthrough(),
        execute: async () => { throw new Error("execute failed"); },
      });
      const calls: unknown[] = [];
      const policy: ApprovalPolicy = { evaluate: () => "allow", onExecuted: (...args) => { calls.push(args); } };
      await expect(
        handleAction(actionReq({ action: "boom" }), deps({ policy, getTools: () => ({ boom: throwingTool }) })),
      ).rejects.toThrow("execute failed");
      expect(calls).toHaveLength(0);
    });
  });
});

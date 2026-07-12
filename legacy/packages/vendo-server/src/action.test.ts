import { describe, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import { z } from "zod";
import {
  buildDescriptor,
  createInMemoryCompiledRuleStore,
  createInMemoryDecisionStore,
  createInMemoryGrantStore,
  hashDescriptor,
  InMemoryAuditLog,
  rememberDecisions,
  type ApprovalPolicy,
} from "@vendoai/runtime";
import { createApprovalStore, handleAction, type ActionDeps } from "./action.js";
import { defaultVendoPolicy } from "./default-policy.js";
import { composeProductionPolicy } from "./policy-stack.js";

function actionReq(body: unknown, host = "localhost:3000"): Request {
  return new Request(`http://${host}/api/vendo/action`, {
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
    policy: defaultVendoPolicy,
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

  it("400s a payload that fails the tool's input schema instead of executing it", async () => {
    const executed: unknown[] = [];
    const strictTool = tool({
      description: "write things",
      inputSchema: z.object({ amount: z.number() }),
      execute: async (input: unknown) => {
        executed.push(input);
        return { wrote: input };
      },
    });
    const policy: ApprovalPolicy = { evaluate: () => "allow" };
    const res = await handleAction(
      actionReq({ action: "create_thing", payload: { amount: "not-a-number" } }),
      deps({ policy, getTools: () => ({ create_thing: strictTool }) }),
    );
    expect(res.status).toBe(400);
    expect(executed).toHaveLength(0);
    // Generic message only — no validator internals cross to the caller.
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid payload for action "create_thing"');
  });

  describe("JSON-schema tools (AI SDK jsonSchema(), no runtime validator)", () => {
    // asSchema(jsonSchema(...)).validate is undefined — validation must NOT
    // fail open. Minimum bar: required + type + additionalProperties.
    const jsonTool = (executed: unknown[]) => ({
      ...tool({
        description: "write things",
        inputSchema: jsonSchema({
          type: "object",
          properties: { amount: { type: "number" } },
          required: ["amount"],
          additionalProperties: false,
        }),
      }),
      execute: async (input: unknown) => {
        executed.push(input);
        return { wrote: input };
      },
    });

    it("400s a wrong-typed field without executing", async () => {
      const executed: unknown[] = [];
      const res = await handleAction(
        actionReq({ action: "create_thing", payload: { amount: "nope" } }),
        deps({ policy: { evaluate: () => "allow" }, getTools: () => ({ create_thing: jsonTool(executed) }) }),
      );
      expect(res.status).toBe(400);
      expect(executed).toHaveLength(0);
      expect(((await res.json()) as { error: string }).error).toBe('invalid payload for action "create_thing"');
    });

    it("400s a missing required field without executing", async () => {
      const executed: unknown[] = [];
      const res = await handleAction(
        actionReq({ action: "create_thing", payload: {} }),
        deps({ policy: { evaluate: () => "allow" }, getTools: () => ({ create_thing: jsonTool(executed) }) }),
      );
      expect(res.status).toBe(400);
      expect(executed).toHaveLength(0);
    });

    it("400s an unexpected additional property without executing", async () => {
      const executed: unknown[] = [];
      const res = await handleAction(
        actionReq({ action: "create_thing", payload: { amount: 5, evil: true } }),
        deps({ policy: { evaluate: () => "allow" }, getTools: () => ({ create_thing: jsonTool(executed) }) }),
      );
      expect(res.status).toBe(400);
      expect(executed).toHaveLength(0);
    });

    it("executes a valid payload", async () => {
      const executed: unknown[] = [];
      const res = await handleAction(
        actionReq({ action: "create_thing", payload: { amount: 5 } }),
        deps({ policy: { evaluate: () => "allow" }, getTools: () => ({ create_thing: jsonTool(executed) }) }),
      );
      expect(res.status).toBe(200);
      expect(executed).toEqual([{ amount: 5 }]);
    });
  });

  it("still executes a schema-valid payload", async () => {
    const policy: ApprovalPolicy = { evaluate: () => "allow" };
    const res = await handleAction(
      actionReq({ action: "create_thing", payload: { amount: 5 } }),
      deps({ policy }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: unknown }).result).toEqual({ wrote: { amount: 5 } });
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
      const policy = composeProductionPolicy(defaultVendoPolicy, {
        grants: createInMemoryGrantStore(),
        rules: createInMemoryCompiledRuleStore(),
        audit,
      });
      const res = await handleAction(actionReq({ action: "get_things" }), deps({ policy }));
      expect(res.status).toBe(200);
      const scope = { tenantId: "vendo-embedded", subject: "vendo-default-user" };
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

  describe("REVIEW FOLLOW-UP: resolveDescriptor source parity (chat/steering grants vs /action dispatch)", () => {
    const writeTool = tool({
      description: "write things",
      inputSchema: z.object({ amount: z.number() }).passthrough(),
      execute: async (input: unknown) => ({ wrote: input }),
    });
    const scope = { tenantId: "vendo-embedded", subject: "vendo-default-user" };

    it("a standing grant minted against the chat-side ('engine') descriptor suppresses the SAME host tool dispatched via /action when resolveDescriptor is wired", async () => {
      const grants = createInMemoryGrantStore();
      // Mirrors handler.ts's resolveDescriptor: a host server tool (not a
      // client tool, not control-plane) resolves to source "engine" — the
      // SAME mapping the chat/consent path uses to mint this grant.
      const chatSideDescriptor = buildDescriptor("create_thing", writeTool, "engine");
      await grants.create(scope, {
        tool: "create_thing",
        descriptorHash: hashDescriptor(chatSideDescriptor),
        scope: { kind: "tool" },
        duration: "standing",
        source: { kind: "chat" },
      });
      const policy = composeProductionPolicy(defaultVendoPolicy, {
        grants,
        rules: createInMemoryCompiledRuleStore(),
        audit: new InMemoryAuditLog(),
      });
      const res = await handleAction(
        actionReq({ action: "create_thing", payload: { amount: 5 } }),
        deps({
          policy,
          getTools: () => ({ create_thing: writeTool }),
          resolveDescriptor: (name) => (name === "create_thing" ? chatSideDescriptor : undefined),
        }),
      );
      // Suppressed by the grant -> executes immediately, no approval gate.
      expect(res.status).toBe(200);
      expect((await res.json()) as { result?: unknown }).toMatchObject({
        decision: "allow",
        result: { wrote: { amount: 5 } },
      });
    });

    it("REGRESSION: the SAME grant does NOT suppress when /action falls back to the OLD 'caller'-sourced descriptor (no resolveDescriptor wired) — proves the source mismatch this fix closes", async () => {
      const grants = createInMemoryGrantStore();
      const chatSideDescriptor = buildDescriptor("create_thing", writeTool, "engine");
      await grants.create(scope, {
        tool: "create_thing",
        descriptorHash: hashDescriptor(chatSideDescriptor),
        scope: { kind: "tool" },
        duration: "standing",
        source: { kind: "chat" },
      });
      const policy = composeProductionPolicy(defaultVendoPolicy, {
        grants,
        rules: createInMemoryCompiledRuleStore(),
        audit: new InMemoryAuditLog(),
      });
      // No resolveDescriptor passed -> action.ts falls back to
      // buildDescriptor(action, tool, "caller"), which hashes differently.
      const res = await handleAction(
        actionReq({ action: "create_thing", payload: { amount: 5 } }),
        deps({ policy, getTools: () => ({ create_thing: writeTool }) }),
      );
      const body = (await res.json()) as { needsApproval?: boolean };
      expect(body.needsApproval).toBe(true); // still gated — the grant never matched
    });
  });
});

describe("ask-once-remember wired through /action", () => {
  it("an approved-and-executed action is remembered: the next identical call auto-executes without a token", async () => {
    const store = createInMemoryDecisionStore();
    const policy = rememberDecisions(defaultVendoPolicy, store, "v1");
    const d = deps({ policy });

    const gate = await handleAction(
      actionReq({ action: "create_thing", payload: { amount: 5 } }),
      d,
    );
    const { approvalToken } = (await gate.json()) as { approvalToken: string };
    const executed = await handleAction(
      actionReq({ action: "create_thing", payload: { amount: 5 }, approvalToken }),
      d,
    );
    expect((await executed.json()) as { decision: string }).toMatchObject({ decision: "approve" });

    // No token this time — remembered decision auto-allows and executes directly.
    const remembered = await handleAction(
      actionReq({ action: "create_thing", payload: { amount: 5 } }),
      d,
    );
    expect(await remembered.json()).toEqual({
      decision: "allow",
      result: { wrote: { amount: 5 } },
    });
  });

  it("a denied action never memoizes and keeps re-prompting", async () => {
    const store = createInMemoryDecisionStore();
    let allowed = false;
    const flakyInner: ApprovalPolicy = {
      evaluate: () => (allowed ? "approve" : "deny"),
    };
    const policy = rememberDecisions(flakyInner, store, "v1");
    const d = deps({ policy });

    const denied = await handleAction(
      actionReq({ action: "create_thing", payload: { amount: 5 } }),
      d,
    );
    expect(denied.status).toBe(403);

    // Flip the inner policy to allow approval, then approve+execute once.
    allowed = true;
    const gate = await handleAction(
      actionReq({ action: "create_thing", payload: { amount: 5 } }),
      d,
    );
    const { approvalToken } = (await gate.json()) as { approvalToken: string };
    const executed = await handleAction(
      actionReq({ action: "create_thing", payload: { amount: 5 }, approvalToken }),
      d,
    );
    expect(((await executed.json()) as { decision: string }).decision).toBe("approve");

    // Now it IS remembered (post-execute), proving the earlier deny never
    // wrote a memo — it took a real approve+execute to start remembering.
    const remembered = await handleAction(
      actionReq({ action: "create_thing", payload: { amount: 5 } }),
      d,
    );
    expect(((await remembered.json()) as { decision: string }).decision).toBe("allow");
  });
});

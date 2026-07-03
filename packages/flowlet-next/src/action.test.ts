import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { createApprovalStore, handleAction, type ActionDeps } from "./action";
import { defaultFlowletPolicy } from "./default-policy";

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
});

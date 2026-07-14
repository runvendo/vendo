import type { AppId, RunContext, ToolCall, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import type { AppDataAccess } from "../app-data.js";
import { createAppsProxy } from "../proxy.js";
import { mintRunToken } from "../run-token.js";

// Red-team suite for the machine capability proxy (06-apps §4.4, plan decision 3).
// THE core claim: the proxy derives its RunContext ONLY from the signed run token.
// Anything the sandboxed app writes into the request body (appId / subject / presence)
// is untrusted attacker input and MUST be ignored. If the body could steer ctx, a
// compromised app could act as another app, another user, or upgrade present->away.

const SECRET = "proxy-process-secret";
const future = (): number => Date.now() + 60_000;

const json = async (response: Response): Promise<unknown> => response.json() as Promise<unknown>;

/** A ToolRegistry spy that records the exact RunContext it was executed with. */
const spyRegistry = (): { registry: ToolRegistry; calls: Array<{ call: ToolCall; ctx: RunContext }> } => {
  const calls: Array<{ call: ToolCall; ctx: RunContext }> = [];
  const descriptors: ToolDescriptor[] = [
    { name: "host_x", description: "x", inputSchema: { type: "object" }, risk: "read" },
  ];
  return {
    calls,
    registry: {
      async descriptors() { return descriptors; },
      async execute(call, ctx) {
        calls.push({ call, ctx });
        return { status: "ok", output: { echoedCtx: ctx } };
      },
    },
  };
};

/** Minimal AppDataAccess double that records the appId/subject it was scoped to. */
const spyData = (): { data: AppDataAccess; state: Array<{ appId: AppId; subject: string }> } => {
  const state: Array<{ appId: AppId; subject: string }> = [];
  return {
    state,
    data: {
      async getState(appId, subject) { state.push({ appId, subject }); return { scopedTo: `${appId}:${subject}` }; },
      async setState(appId, subject) { state.push({ appId, subject }); },
      async clear() { /* not exercised */ },
    },
  };
};

const mintFor = (claims: { appId: string; subject: string; presence: "present" | "away" }): Promise<string> =>
  mintRunToken(SECRET, { ...claims, runId: "run_x", expiresAt: future(), jti: "jti_x" });

describe("proxy privilege escalation", () => {
  it("derives ctx from the signed token and IGNORES appId/subject/presence in the body", async () => {
    const { registry, calls } = spyRegistry();
    const { data } = spyData();
    const proxy = createAppsProxy({ tokenSecret: SECRET, tools: registry, data, owns: async () => true });
    const token = await mintFor({ appId: "app_A", subject: "sub_A", presence: "present" });

    const response = await proxy.handler(new Request("https://proxy.test/tools/host_x", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      // Hostile body: try to steer ctx to another app / user / presence.
      body: JSON.stringify({ args: { real: 1 }, appId: "app_B", presence: "away", subject: "sub_evil" }),
    }));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const ctx = calls[0]!.ctx;
    expect(ctx.appId).toBe("app_A");
    expect(ctx.presence).toBe("present");
    expect(ctx.principal).toEqual({ kind: "user", subject: "sub_A" });
    expect(ctx.venue).toBe("app");
    // Only the args field is passed through; the body's authority fields never reach the tool.
    expect(calls[0]!.call.args).toEqual({ real: 1 });
  });

  it("scopes /state reads to the token app, never a body/query-supplied app", async () => {
    const { registry } = spyRegistry();
    const { data, state } = spyData();
    const proxy = createAppsProxy({ tokenSecret: SECRET, tools: registry, data, owns: async () => true });
    const token = await mintFor({ appId: "app_A", subject: "sub_A", presence: "present" });

    // Attacker appends ?appId=app_other; the proxy must ignore it.
    await proxy.handler(new Request("https://proxy.test/state?appId=app_other", {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(state).toEqual([{ appId: "app_A", subject: "sub_A" }]);
  });

  it("returns 401 for a missing bearer and for an invalid/forged token", async () => {
    const { registry, calls } = spyRegistry();
    const { data } = spyData();
    const proxy = createAppsProxy({ tokenSecret: SECRET, tools: registry, data, owns: async () => true });

    const noBearer = await proxy.handler(new Request("https://proxy.test/tools/host_x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: {} }),
    }));
    expect(noBearer.status).toBe(401);

    const forged = await mintRunToken("WRONG-secret", { appId: "app_A", subject: "sub_A", runId: "run_x", presence: "present", expiresAt: future(), jti: "jti_x" });
    const badToken = await proxy.handler(new Request("https://proxy.test/tools/host_x", {
      method: "POST",
      headers: { authorization: `Bearer ${forged}`, "content-type": "application/json" },
      body: JSON.stringify({ args: {} }),
    }));
    expect(badToken.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("returns 404 when ownership check fails even with a valid token", async () => {
    const { registry, calls } = spyRegistry();
    const { data } = spyData();
    const owns = vi.fn(async () => false);
    const proxy = createAppsProxy({ tokenSecret: SECRET, tools: registry, data, owns });
    const token = await mintFor({ appId: "app_A", subject: "sub_A", presence: "present" });

    const response = await proxy.handler(new Request("https://proxy.test/tools/host_x", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ args: {} }),
    }));
    expect(response.status).toBe(404);
    // owns() is asked with the TOKEN's appId/subject, not anything from the body.
    expect(owns).toHaveBeenCalledWith("app_A", "sub_A");
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-application/json content-type on /tools with 400", async () => {
    const { registry } = spyRegistry();
    const { data } = spyData();
    const proxy = createAppsProxy({ tokenSecret: SECRET, tools: registry, data, owns: async () => true });
    const token = await mintFor({ appId: "app_A", subject: "sub_A", presence: "present" });

    const response = await proxy.handler(new Request("https://proxy.test/tools/host_x", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
      body: "{}",
    }));
    expect(response.status).toBe(400);
  });

  it("rejects a PUT /state body larger than 256KB with 400 without persisting", async () => {
    const { registry } = spyRegistry();
    const { data, state } = spyData();
    const proxy = createAppsProxy({ tokenSecret: SECRET, tools: registry, data, owns: async () => true });
    const token = await mintFor({ appId: "app_A", subject: "sub_A", presence: "present" });

    const response = await proxy.handler(new Request("https://proxy.test/state", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ blob: "x".repeat(256 * 1024) }),
    }));
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: { code: "validation" } });
    expect(state).toEqual([]); // setState never reached
  });

  it("returns 404 for unknown routes", async () => {
    const { registry } = spyRegistry();
    const { data } = spyData();
    const proxy = createAppsProxy({ tokenSecret: SECRET, tools: registry, data, owns: async () => true });
    const response = await proxy.handler(new Request("https://proxy.test/definitely-unknown"));
    expect(response.status).toBe(404);
  });
});

/**
 * ADVERSARIAL CHECK on the standalone agent's permission mount. Two questions:
 * can one person reach another person's rows through it, and can a crafted path
 * reach a route the mount does not own.
 */
import type { Principal } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore } from "@vendoai/store";
import { describe, expect, it } from "vitest";
import { agent, agentComposition } from "../src/agent.js";
import { PERMISSIONS_PATH } from "../src/permissions.js";
import { tool } from "../src/tools.js";

let stores = 0;
const memoryStore = () => createStore({ dataDir: `memory://agents-permissions-check-${stores++}` });
const inert = () => defineHarness({ name: "inert", async *run() {} });

const alice: Principal = { kind: "user", subject: "user_alice" };
const bob: Principal = { kind: "user", subject: "user_bob" };

const sendReport = tool({
  name: "host_send_report",
  description: "Send a report",
  inputSchema: { type: "object", properties: { body: { type: "string" } } },
  risk: "write",
  async execute() {
    return { status: "ok", output: {} };
  },
});

/** One agent, two visitors: the `x-subject` header says which. */
function built() {
  return agent({
    name: "reporter",
    harness: inert(),
    store: memoryStore(),
    tools: [sendReport],
    guard: { policy: { rules: [{ match: { risk: "write" }, action: "ask" }] } },
    async principal(request) {
      return request.headers.get("x-subject") === "bob" ? bob : alice;
    },
  });
}

const request = (method: string, path: string, as: "alice" | "bob" = "alice", body?: unknown): Request =>
  new Request(`https://app.example.com${path}`, {
    method,
    headers: { "x-subject": as, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function park(reporter: ReturnType<typeof agent>): Promise<string> {
  const composition = agentComposition(reporter)!;
  await composition.store.ensureSchema();
  const outcome = await composition.tools.execute(
    { id: "call_check_1", tool: "host_send_report", args: { body: "the report" } },
    { principal: alice, venue: "chat", presence: "present", sessionId: "session_1" },
  );
  if (outcome.status !== "pending-approval") throw new Error(`expected a park, got ${outcome.status}`);
  return outcome.approvalId;
}

describe("CHECK: the agent mount is owner-scoped on all five routes", () => {
  it("shows Bob nothing of Alice's and lets him decide, revoke or delete none of it", async () => {
    const reporter = built();
    const approvalId = await park(reporter);

    const bobsQueue = await reporter.permissions(request("GET", `${PERMISSIONS_PATH}/approvals`, "bob"));
    expect(await bobsQueue?.json()).toEqual([]);

    const stolen = await reporter.permissions(request("POST", `${PERMISSIONS_PATH}/approvals/decide`, "bob", {
      ids: [approvalId],
      decision: { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
    }));
    expect(stolen?.status).toBe(404);

    const takenBack = await reporter.permissions(
      request("DELETE", `${PERMISSIONS_PATH}/approvals/${approvalId}`, "bob"),
    );
    expect(takenBack?.status).toBe(404);

    // Alice's ask is untouched, and Bob minted himself nothing.
    const hers = await reporter.permissions(request("GET", `${PERMISSIONS_PATH}/approvals`, "alice"));
    expect(await hers?.json()).toMatchObject([{ id: approvalId }]);
    const hisGrants = await reporter.permissions(request("GET", `${PERMISSIONS_PATH}/grants`, "bob"));
    expect(await hisGrants?.json()).toEqual([]);
  });

  it("will not let Bob revoke a grant of Alice's", async () => {
    const reporter = built();
    const approvalId = await park(reporter);
    await reporter.permissions(request("POST", `${PERMISSIONS_PATH}/approvals/decide`, "alice", {
      ids: [approvalId],
      decision: { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
    }));
    const listed = await reporter.permissions(request("GET", `${PERMISSIONS_PATH}/grants`, "alice"));
    const [grant] = await listed!.json() as Array<{ id: string }>;

    const stolen = await reporter.permissions(request("DELETE", `${PERMISSIONS_PATH}/grants/${grant!.id}`, "bob"));

    expect(stolen?.status).toBe(404);
    const after = await reporter.permissions(request("GET", `${PERMISSIONS_PATH}/grants`, "alice"));
    const [still] = await after!.json() as Array<{ id: string; revokedAt?: string }>;
    expect(still!.id).toBe(grant!.id);
    expect(still!.revokedAt).toBeUndefined();
  });
});

describe("CHECK: the agent mount owns exactly its own paths", () => {
  it("does not answer for a path that merely SHARES the mount's first characters", async () => {
    const reporter = built();
    await agentComposition(reporter)!.store.ensureSchema();

    // `/api/vendo` is the mount; `/api/vendoapprovals` is a different path
    // entirely. The host is told this handler answers `undefined` for everything
    // it does not own, so a catch-all can chain it — that promise is what breaks.
    expect(await reporter.permissions(request("GET", "/api/vendoapprovals"))).toBeUndefined();
    expect(await reporter.permissions(request("GET", "/api/vendogrants"))).toBeUndefined();
  });

  it("still falls through for everything under the door", async () => {
    const reporter = built();

    expect(await reporter.permissions(request("POST", "/api/vendo/mcp"))).toBeUndefined();
    expect(await reporter.permissions(request("POST", "/api/vendo/mcp/message"))).toBeUndefined();
  });
});

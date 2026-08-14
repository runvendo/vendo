/**
 * The agent's permission mount, over the REAL guard the agent composed — the
 * same one its turns park approvals into. A host mounts ONE catch-all under
 * `/api/vendo`, so the two things that matter are that these routes answer from
 * live guard state and that everything else — the MCP door above all — comes
 * back undefined for the host's next handler.
 */
import type { Principal } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore } from "@vendoai/store";
import { describe, expect, it } from "vitest";
import { agent, agentComposition } from "../src/agent.js";
import { DOOR_PATH } from "../src/door.js";
import { PERMISSIONS_PATH } from "../src/permissions.js";
import { tool } from "../src/tools.js";

let stores = 0;
const memoryStore = () => createStore({ dataDir: `memory://agents-permissions-${stores++}` });

const inert = () => defineHarness({ name: "inert", async *run() {} });

const alice: Principal = { kind: "user", subject: "user_alice" };

const sendReport = tool({
  name: "host_send_report",
  description: "Send a report",
  inputSchema: { type: "object", properties: { body: { type: "string" } } },
  risk: "write",
  async execute() {
    return { status: "ok", output: {} };
  },
});

function built(principal?: (request: Request) => Promise<Principal | null>) {
  return agent({
    name: "reporter",
    harness: inert(),
    store: memoryStore(),
    tools: [sendReport],
    guard: { policy: { rules: [{ match: { risk: "write" }, action: "ask" }] } },
    ...(principal === undefined ? {} : { principal }),
  });
}

const request = (method: string, path: string, body?: unknown): Request =>
  new Request(`https://app.example.com${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });

/** One parked write, through the agent's OWN guard-bound registry. */
async function park(reporter: ReturnType<typeof agent>): Promise<string> {
  const composition = agentComposition(reporter)!;
  // Nothing has touched the store yet — a turn would have; this park is direct.
  await composition.store.ensureSchema();
  const outcome = await composition.tools.execute(
    { id: "call_permissions_1", tool: "host_send_report", args: { body: "the report" } },
    { principal: alice, venue: "chat", presence: "present", sessionId: "session_1" },
  );
  if (outcome.status !== "pending-approval") throw new Error(`expected a park, got ${outcome.status}`);
  return outcome.approvalId;
}

describe("the agent's permission mount", () => {
  it("answers the approvals and grants routes from the agent's own guard", async () => {
    const reporter = built(async () => alice);
    const approvalId = await park(reporter);

    const pending = await reporter.permissions(request("GET", `${PERMISSIONS_PATH}/approvals`));
    expect(pending?.status).toBe(200);
    expect(await pending?.json()).toMatchObject([{ id: approvalId }]);

    const decided = await reporter.permissions(request("POST", `${PERMISSIONS_PATH}/approvals/decide`, {
      ids: [approvalId],
      decision: { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
    }));
    expect(decided?.status).toBe(200);

    const grants = await reporter.permissions(request("GET", `${PERMISSIONS_PATH}/grants`));
    expect(await grants?.json()).toMatchObject([{ tool: "host_send_report", duration: "standing" }]);
  });

  it("answers a VIRGIN store — a fresh agent polled before its first turn — with an empty queue", async () => {
    const reporter = built(async () => alice);

    const pending = await reporter.permissions(request("GET", `${PERMISSIONS_PATH}/approvals`));

    expect(pending?.status).toBe(200);
    expect(await pending?.json()).toEqual([]);
  });

  it("falls THROUGH on a virgin store too — a route it does not own owes it no schema", async () => {
    const reporter = built(async () => alice);

    expect(await reporter.permissions(request("POST", DOOR_PATH))).toBeUndefined();
    expect(await reporter.permissions(request("GET", "/api/vendoapprovals"))).toBeUndefined();
  });

  it("falls THROUGH for the door and for everything else on the mount", async () => {
    const reporter = built(async () => alice);

    // The door lives under the same base — one catch-all route serves both, and
    // only because this hands the path back instead of answering not-found.
    expect(await reporter.permissions(request("POST", DOOR_PATH))).toBeUndefined();
    expect(await reporter.permissions(request("GET", "/api/vendo/threads"))).toBeUndefined();
    expect(await reporter.permissions(request("GET", "/"))).toBeUndefined();
  });

  it("401s when the host configured no principal resolver — and still falls through for the door", async () => {
    const reporter = built();

    expect((await reporter.permissions(request("GET", `${PERMISSIONS_PATH}/approvals`)))?.status).toBe(401);
    expect((await reporter.permissions(request("GET", `${PERMISSIONS_PATH}/grants`)))?.status).toBe(401);
    expect(await reporter.permissions(request("POST", DOOR_PATH))).toBeUndefined();
  });

  it("401s when the resolver says this visitor has no identity", async () => {
    const reporter = built(async () => null);

    expect((await reporter.permissions(request("GET", `${PERMISSIONS_PATH}/approvals`)))?.status).toBe(401);
  });
});

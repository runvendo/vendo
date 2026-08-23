/**
 * THE SEAM for a call parked at the MCP DOOR: the door parks it, the WIRE's
 * `GET /approvals/:id` answers for it, and the outside agent retries on the
 * SAME session. Nothing between them is stubbed — `vendo.handler` is both the
 * door and the wire, and the guard, the store and the tool are real.
 *
 * The door parks through the plain guard-bound registry (`compose-mcp` passes
 * `boundTools`, not the BYO parking registry), so no parked-call record exists
 * for the resume subscriber to find: approving GRANTS the call, it never
 * executes it — the door's own refusal line says "resolve it there, then
 * retry". `read` therefore had nothing left to answer with once the approval
 * left the pending queue and threw not-found, which `<VendoApprovalEmbed>`
 * renders as "Expired — no longer waiting for approval" on the very approval
 * the person had just granted (observed live 2026-08-23).
 */
import type { ApprovalRequest, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDoor,
  principal,
  runCleanups,
  SUBJECT,
  tempStore,
  type DoorSession,
} from "../src/mcp-door.test-util.js";
import { createVendo, type Vendo } from "../src/server.js";

afterEach(runCleanups);

const KEY = "vsk_0123456789abcdef0123456789abcdef0123456789abcdef";
const BASE = "https://host.test";
const WIRE = `${BASE}/api/vendo`;
const TODO_TOOL = "host_todos_create";
const ARGS = { title: "Buy milk" };

/** The observed host tool: ONE write the `cautious` policy parks, counting
 *  every execution so "ran exactly once" is measured, not assumed. */
function todoHost(): { tools: ToolRegistry; created: string[] } {
  const created: string[] = [];
  const descriptor: ToolDescriptor = {
    name: TODO_TOOL,
    title: "Add a todo",
    description: "Add a todo for the signed-in customer",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    risk: "write",
  };
  return {
    created,
    tools: {
      async descriptors() {
        return [descriptor];
      },
      async execute(call) {
        created.push((call.args as { title: string }).title);
        return { status: "ok", output: { added: true } };
      },
    },
  };
}

interface Host {
  vendo: Vendo;
  created: string[];
  door: DoorSession;
}

async function host(clock?: () => number): Promise<Host> {
  const store = await tempStore();
  const app = todoHost();
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    guard: { policy: "cautious", approvals: { parkedCallTtlMs: 10_000 } },
    ...(clock === undefined ? {} : { sweep: { intervalMs: 1, now: clock } }),
    mcp: { serviceAuth: { keys: [KEY] }, baseUrl: BASE },
    oauth: {
      async session() {
        return { subject: SUBJECT };
      },
      async principal(subject: string) {
        return { kind: "user", subject };
      },
    },
  } as Parameters<typeof createVendo>[0]);
  vendo.actions.add(app.tools);
  await store.ensureSchema();
  // ONE kept-alive session, exactly as a host's own agent loop holds it: the
  // park and the retry both ride it, which is what makes the replay id stable.
  const door = await openDoor(vendo, await vendo.tokenFor(SUBJECT));
  return { vendo, created: app.created, door };
}

/** The parked call's approval id, off the typed envelope the door returns —
 *  the same field `<VendoApprovalEmbed>` is handed. */
async function park(door: DoorSession): Promise<string> {
  const parked = await door.callTool(TODO_TOOL, ARGS);
  const ref = parked.structuredContent as { kind?: string; approvalId?: string } | undefined;
  expect(ref?.kind).toBe("vendo/approval-ref@1");
  expect(typeof ref?.approvalId).toBe("string");
  return ref!.approvalId!;
}

type Resolution = { state: string; request?: ApprovalRequest };

/** What the embed's poll sees, over the real wire. */
async function poll(vendo: Vendo, approvalId: string): Promise<Resolution & { status: number }> {
  const response = await vendo.handler(new Request(`${WIRE}/approvals/${approvalId}`));
  const body = response.ok ? ((await response.json()) as Resolution) : { state: "not-found" };
  return { ...body, status: response.status };
}

async function decide(vendo: Vendo, approvalId: string, approve: boolean): Promise<void> {
  const decided = await vendo.handler(new Request(`${WIRE}/approvals/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [approvalId], decision: { approve } }),
  }));
  if (!decided.ok) throw new Error(`decide failed ${decided.status}: ${await decided.text()}`);
}

describe.sequential("a call parked at the MCP door, read over the wire", () => {
  it("reads approved-then-ran, never expired, and the retry runs it exactly once", async () => {
    const { vendo, created, door } = await host();

    const approvalId = await park(door);
    expect(created).toEqual([]);

    // 1. The card's first poll: the ask itself, so the consent card has inputs.
    const pending = await poll(vendo, approvalId);
    expect(pending.state).toBe("pending");
    expect(pending.request?.call.tool).toBe(TODO_TOOL);

    // 2. The user presses Approve.
    await decide(vendo, approvalId, true);
    // Approving GRANTS the parked door call; it does not execute it. Were it
    // both, the retry below would be a second write of the same todo.
    expect(created).toEqual([]);

    // 3. The poll straight after the press. It must never read "expired" — the
    //    yes stands, so the card keeps its working beat and its poll.
    const granted = await poll(vendo, approvalId);
    expect(granted.status).toBe(200);
    expect(granted.state).toBe("pending");
    // No ask to re-show: it is decided, so the card must not offer the buttons
    // a second time.
    expect(granted.request).toBeUndefined();

    // 4. The agent retries on the SAME session, and the call finally runs.
    const ran = await door.callTool(TODO_TOOL, ARGS);
    expect(ran.isError).toBeFalsy();
    expect(created).toEqual([ARGS.title]);

    // 5. The card settles on the executed receipt — "Approved — ran".
    expect(await poll(vendo, approvalId)).toMatchObject({ state: "executed", status: 200 });

    // The yes was single-use: an identical third call parks anew rather than
    // riding a spent approval.
    const again = await door.callTool(TODO_TOOL, ARGS);
    expect((again.structuredContent as { kind?: string } | undefined)?.kind).toBe("vendo/approval-ref@1");
    expect(created).toEqual([ARGS.title]);
  });

  it("reads a refused door call as declined, not expired", async () => {
    const { vendo, created, door } = await host();
    const approvalId = await park(door);

    await decide(vendo, approvalId, false);

    expect(await poll(vendo, approvalId)).toMatchObject({ state: "declined", status: 200 });
    expect(created).toEqual([]);
  });

  it("still reads a door call nobody answered as expired once the TTL sweep denies it", async () => {
    let at = Date.now();
    const { vendo, created, door } = await host(() => at);
    const approvalId = await park(door);

    // Past the TTL: the next request's amortized sweep denies it, with SYSTEM
    // provenance — the one denial that is not a person saying no. Re-anchored
    // on the real clock because the park lands after this test's first read.
    at = Date.now() + 11_000;
    expect((await vendo.handler(new Request(`${WIRE}/status`))).status).toBe(200);

    expect(await poll(vendo, approvalId)).toMatchObject({ state: "expired", status: 200 });
    expect(created).toEqual([]);
  });
});

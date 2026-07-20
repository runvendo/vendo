import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VendoError,
  type Principal,
  type RunContext,
  type ToolCall,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createByoApprovals } from "./byo-approvals.js";

// Existing-agents Lane B — a guarded call parked from a BYO agent loop has NO
// Vendo thread to resume through and NO app to own its lifecycle. This is the
// venue-neutral park→resume seam: the parking registry records the exact call
// when the guard answers pending-approval, the umbrella-level subscriber
// executes it on approve / discards it on deny, the time-based sweep expires
// orphans through the SAME deny path, and the outcome persists so the wire can
// answer "what happened to apr_x?" for <VendoApprovalEmbed>.

const principal: Principal = { kind: "user", subject: "user_byo" };
// The tool pack's frozen context tuple: venue "chat", present, no appId.
const ctx: RunContext = {
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "session_byo",
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A host with ONE mutating tool that records what it delivered — the
 *  observable the park/resume assertions hang on. */
function messagingHost(): {
  tools: ToolRegistry;
  delivered: Array<{ clientId: string; body: string }>;
} {
  const delivered: Array<{ clientId: string; body: string }> = [];
  const send: ToolDescriptor = {
    name: "host_sendClientMessage",
    description: "Message a client about their account",
    inputSchema: {
      type: "object",
      properties: { clientId: { type: "string" }, body: { type: "string" } },
      required: ["clientId", "body"],
    },
    risk: "write",
  };
  const lookup: ToolDescriptor = {
    name: "host_lookupClient",
    description: "Look up a client",
    inputSchema: { type: "object", properties: { clientId: { type: "string" } } },
    risk: "read",
  };
  return {
    delivered,
    tools: {
      async descriptors() {
        return [send, lookup];
      },
      async execute(call) {
        if (call.tool === "host_lookupClient") {
          return { status: "ok", output: { clientId: call.args } };
        }
        if (call.tool !== "host_sendClientMessage") {
          return { status: "error", error: { code: "not-found", message: `no tool ${call.tool}` } };
        }
        const { clientId, body } = call.args as { clientId: string; body: string };
        delivered.push({ clientId, body });
        return { status: "ok", output: { delivered: true } };
      },
    },
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "vendo-byo-approvals-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const store = createStore({ dataDir: join(root, ".data") });
  cleanups.push(async () => store.close());
  await store.ensureSchema();
  // Every write-class call asks — the gate the pack's approval envelope rides.
  const guard = createGuard({ store, policy: { rules: [{ match: { risk: "write" }, action: "ask" }] } });
  const host = messagingHost();
  const byo = createByoApprovals({ guard, tools: guard.bind(host.tools), store });
  return { guard, store, host, byo };
}

const sendCall = (id: string, body: string): ToolCall => ({
  id,
  tool: "host_sendClientMessage",
  args: { clientId: "cli_1", body },
});

describe.sequential("existing-agents — parked BYO guarded calls", () => {
  it("parks a guarded call, reads pending, then executes it on approve and reads the executed outcome", async () => {
    const { guard, host, byo } = await harness();

    const parked = await byo.registry.execute(sendCall("call_1", "Your documents are overdue"), ctx);
    expect(parked.status).toBe("pending-approval");
    if (parked.status !== "pending-approval") throw new Error("expected the mutation to park");
    expect(host.delivered).toHaveLength(0);

    // The embed's first poll: pending, with the full request for the card.
    const pending = await byo.read(parked.approvalId, principal);
    expect(pending.state).toBe("pending");
    if (pending.state !== "pending") throw new Error("expected pending");
    expect(pending.request.call.tool).toBe("host_sendClientMessage");
    expect(pending.request.inputPreview).toContain("overdue");

    // The owner approves through the real approval API (what the wire serves).
    await guard.approvals.decide(parked.approvalId, { approve: true }, principal);

    // The parked call re-dispatched byte-for-byte: the effect landed exactly once.
    expect(host.delivered).toEqual([{ clientId: "cli_1", body: "Your documents are overdue" }]);
    const resolved = await byo.read(parked.approvalId, principal);
    expect(resolved).toEqual({
      state: "executed",
      outcome: { status: "ok", output: { delivered: true } },
    });
  });

  it("discards a denied call — the effect never lands and the read reports declined", async () => {
    const { guard, host, byo } = await harness();

    const parked = await byo.registry.execute(sendCall("call_2", "This should never send"), ctx);
    if (parked.status !== "pending-approval") throw new Error("expected the mutation to park");

    await guard.approvals.decide(parked.approvalId, { approve: false }, principal);

    expect(host.delivered).toHaveLength(0);
    await expect(byo.read(parked.approvalId, principal)).resolves.toEqual({ state: "declined" });
  });

  it("expires an orphaned parked call through the existing deny path and reads expired", async () => {
    const { guard, host, byo } = await harness();

    const parked = await byo.registry.execute(sendCall("call_3", "Abandoned in a foreign chat"), ctx);
    if (parked.status !== "pending-approval") throw new Error("expected the mutation to park");

    // Not yet past the TTL: nothing expires.
    await byo.sweepExpired(60_000, Date.now());
    expect((await guard.approvals.pending(principal)).map((request) => request.id)).toContain(parked.approvalId);

    // Past the TTL: the sweep denies it (abandonApprovals semantics) and the
    // embed's read resolves to the expired vocabulary — never a silent blank.
    await byo.sweepExpired(60_000, Date.now() + 61_000);
    expect(await guard.approvals.pending(principal)).toHaveLength(0);
    expect(host.delivered).toHaveLength(0);
    await expect(byo.read(parked.approvalId, principal)).resolves.toEqual({ state: "expired" });

    // Idempotent: a second sweep pass is a no-op.
    await byo.sweepExpired(60_000, Date.now() + 120_000);
    await expect(byo.read(parked.approvalId, principal)).resolves.toEqual({ state: "expired" });
  });

  it("scopes reads to the owner and answers not-found for unknown ids", async () => {
    const { byo } = await harness();

    const parked = await byo.registry.execute(sendCall("call_4", "Scoped"), ctx);
    if (parked.status !== "pending-approval") throw new Error("expected the mutation to park");

    const stranger: Principal = { kind: "user", subject: "user_other" };
    await expect(byo.read(parked.approvalId, stranger)).rejects.toThrowError(VendoError);
    await expect(byo.read("apr_missing", principal)).rejects.toThrowError(VendoError);
  });

  it("parks nothing for a call the guard runs immediately", async () => {
    const { store, byo } = await harness();

    const outcome = await byo.registry.execute(
      { id: "call_5", tool: "host_lookupClient", args: { clientId: "cli_1" } },
      ctx,
    );
    expect(outcome.status).toBe("ok");
    const page = await store.records("vendo_parked_call").list({});
    expect(page.records).toHaveLength(0);
  });

  it("keeps the executed outcome readable when the resumed call itself fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-byo-approvals-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    const guard = createGuard({ store, policy: { rules: [{ match: { risk: "write" }, action: "ask" }] } });
    let fail = false;
    const flaky: ToolRegistry = {
      async descriptors() {
        return [{
          name: "host_flaky",
          description: "Fails after approval",
          inputSchema: { type: "object" },
          risk: "write",
        }];
      },
      async execute() {
        if (fail) throw new Error("downstream exploded");
        return { status: "ok", output: {} };
      },
    };
    const byo = createByoApprovals({ guard, tools: guard.bind(flaky), store });

    const parked = await byo.registry.execute({ id: "call_6", tool: "host_flaky", args: {} }, ctx);
    if (parked.status !== "pending-approval") throw new Error("expected the mutation to park");
    fail = true;
    await guard.approvals.decide(parked.approvalId, { approve: true }, principal);

    // The guard binding folds the throw into an error outcome; the embed
    // renders it with the existing failed vocabulary instead of a blank.
    const resolved = await byo.read(parked.approvalId, principal);
    expect(resolved.state).toBe("executed");
    if (resolved.state !== "executed") throw new Error("expected executed");
    expect(resolved.outcome.status).toBe("error");
  });
});

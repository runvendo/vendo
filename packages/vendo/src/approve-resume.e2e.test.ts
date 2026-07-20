import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApps } from "@vendoai/apps";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Principal,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";

// W0 — the approve→resume engine fix (held-out gate C4/C11): a mutating in-app
// action parks an approval, the owner approves it through the REAL approval API,
// and the tool effect MUST land (before the fix it stalled at "Running"
// forever). This is the integration seam: the real guard + the apps runtime +
// a host tool with an OBSERVABLE side effect, wired exactly as the umbrella does.

const principal: Principal = { kind: "user", subject: "user_resume" };
const ctx: RunContext = {
  principal,
  venue: "app",
  presence: "present",
  sessionId: "session_resume",
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A host with ONE mutating tool whose only job is to record what it delivered —
 *  the host-side observable the gate asserts on. */
function messagingHost(): {
  tools: ToolRegistry;
  delivered: Array<{ clientId: string; body: string }>;
} {
  const delivered: Array<{ clientId: string; body: string }> = [];
  const descriptor: ToolDescriptor = {
    name: "host_sendClientMessage",
    description: "Message a client about their account",
    inputSchema: {
      type: "object",
      properties: { clientId: { type: "string" }, body: { type: "string" } },
      required: ["clientId", "body"],
    },
    risk: "write",
  };
  return {
    delivered,
    tools: {
      async descriptors() {
        return [descriptor];
      },
      async execute(call) {
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
  const root = await mkdtemp(join(tmpdir(), "vendo-approve-resume-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const store = createStore({ dataDir: join(root, ".data") });
  cleanups.push(async () => store.close());
  await store.ensureSchema();
  // Every write-class call asks — the mutation-gate the whole feature depends on.
  const guard = createGuard({ store, policy: { rules: [{ match: { risk: "write" }, action: "ask" }] } });
  const host = messagingHost();
  const apps = createApps({ store, guard, tools: guard.bind(host.tools), catalog: [] });
  const app = await apps.importApp(
    {
      format: VENDO_APP_FORMAT,
      id: "app_seed_id_is_replaced",
      name: "Client messenger",
      ui: "tree",
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [{ id: "root", component: "Stack", source: "prewired" }],
      },
    } as AppDocument,
    ctx,
  );
  return { guard, apps, host, appId: app.id };
}

describe.sequential("W0 — approve→resume: an approved gated action lands its effect", () => {
  it("parks, then lands the host effect the instant the owner approves", async () => {
    const { guard, apps, host, appId } = await harness();

    const parked = await apps.call(
      appId,
      "host_sendClientMessage",
      { clientId: "cli_1", body: "Your documents are overdue" },
      ctx,
    );
    expect(parked.status).toBe("pending-approval");
    if (parked.status !== "pending-approval") throw new Error("expected the mutation to park");
    // Nothing has happened yet — the gate is holding the write.
    expect(host.delivered).toHaveLength(0);

    // The owner approves through the real approval API (the workspace surface).
    await guard.approvals.decide(parked.approvalId, { approve: true }, principal);

    // THE BUG: before the fix, delivered is still empty here — the approval
    // flipped to granted but nobody re-dispatched the parked call.
    expect(host.delivered).toEqual([{ clientId: "cli_1", body: "Your documents are overdue" }]);
  });

  it("a denied gated action never lands its effect", async () => {
    const { guard, apps, host, appId } = await harness();

    const parked = await apps.call(
      appId,
      "host_sendClientMessage",
      { clientId: "cli_2", body: "This should never send" },
      ctx,
    );
    if (parked.status !== "pending-approval") throw new Error("expected the mutation to park");

    await guard.approvals.decide(parked.approvalId, { approve: false }, principal);

    expect(host.delivered).toHaveLength(0);
  });
});

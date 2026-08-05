/**
 * The turn id — contract §3.5.
 *
 * Before this there was no turn id anywhere, so an audit row, a mirrored tool
 * call and a painted view could not be joined to the exchange they came out of.
 * "Which calls belonged to the turn where the user asked for X" was unanswerable
 * from the audit plane, which is the plane billing and reconciliation read.
 *
 * This drives ONE real composed turn through `vendo.handler` — real store, real
 * guard, real registry, real policy — and reads the audit rows back out of the
 * store through the store's own read path. No double stands between the harness
 * that saw `turn.turnId` and the rows that must carry it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connector } from "@vendoai/actions";
import type { AuditEvent, Principal, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_turnid" };
const THREAD = "thr_turnid";
const READ_TOOL = "maple_invoices_list";

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-turnid-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

function hostTools(): ToolRegistry {
  const descriptors: ToolDescriptor[] = [{
    name: READ_TOOL,
    title: "List invoices",
    description: "List the signed-in customer's invoices",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  }];
  return {
    async descriptors() {
      return descriptors;
    },
    async execute() {
      return { status: "ok", output: { ok: true } };
    },
  };
}

const auditRows = async (store: VendoStore): Promise<AuditEvent[]> => {
  const { records } = await store.records("vendo_audit").list({ refs: { subject: principal.subject } });
  return records.map((record) => record.data as unknown as AuditEvent);
};

describe("the turn id (contract §3.5)", () => {
  it("stamps one id on the Turn and on every audit row that turn produced", async () => {
    const store = await tempStore();
    const seen: string[] = [];

    const harness = defineHarness({
      name: "turn-id-probe",
      async *run(turn) {
        seen.push(turn.turnId);
        // A guarded call: its audit row is minted inside the guard, from the ctx.
        await turn.tools.call(READ_TOOL, {});
        // Usage forces `reportRun`'s per-turn metering row, which is hand-built
        // rather than minted from the guard's helper — the row most likely to be
        // forgotten, and the row billing reads.
        yield { type: "usage", inputTokens: 10, outputTokens: 2, model: "test-model" };
        yield { type: "text", delta: "Two invoices." };
      },
    });

    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      store,
      harness: harness as never,
    } as Parameters<typeof createVendo>[0]);
    vendo.actions.add(hostTools());

    const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: THREAD,
        message: { id: "m1", role: "user", parts: [{ type: "text", text: "list my invoices" }] },
      }),
    }));
    await response.text();
    expect(response.status).toBe(200);

    const turnId = seen[0];
    expect(turnId, "the harness was handed a turn id").toMatch(/^trn_[0-9a-f]{32}$/);
    // Minted per turn, so the id the harness read is not a constant.
    expect(seen).toHaveLength(1);

    const rows = await auditRows(store);
    // Proven over a non-empty set: the guarded call's row and the metering row.
    expect(rows.length, "the turn produced audit rows to join").toBeGreaterThanOrEqual(2);
    expect(rows.some((row) => row.kind === "tool-call" && row.tool === READ_TOOL)).toBe(true);
    expect(rows.some((row) => row.kind === "run")).toBe(true);

    const unjoinable = rows.filter((row) => row.turnId !== turnId);
    expect(
      unjoinable.map((row) => `${row.kind}${row.tool === undefined ? "" : ` ${row.tool}`}`),
      "every audit row this turn produced must name the turn",
    ).toEqual([]);
  }, 60_000);

  it("stamps the turn on a GATED call's row — the only row that call produces", async () => {
    const store = await tempStore();
    const seen: string[] = [];

    // An unconnected brokered tool. The connect gate wraps OUTSIDE guard.bind,
    // so this call never reaches the guard at all: the gate short-circuits it
    // and reports the row ITSELF. That makes this row the whole audit record of
    // the attempt — and it is exactly the row that was hand-copying the ctx.
    const connector: Connector = {
      name: "composio",
      descriptors: async () => [{
        name: "gmail_GMAIL_SEND_EMAIL",
        description: "Send an email",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        risk: "write",
      }],
      execute: async () => ({ status: "ok", output: { sent: true } }),
      toolkitOf: (tool) => (tool.startsWith("gmail_") ? "gmail" : undefined),
      connections: {
        list: async () => [],
        initiate: async () => ({ id: "conn_1", status: "pending", redirectUrl: "https://example.test" }),
      },
    } as unknown as Connector;

    const harness = defineHarness({
      name: "gate-probe",
      async *run(turn) {
        seen.push(turn.turnId);
        const result = await turn.tools.call("gmail_GMAIL_SEND_EMAIL", {});
        // Proven over a real gate, not an assumption: if this ever stops being
        // the connect-required path the row below is a different row.
        expect(JSON.stringify(result)).toContain("connect");
        yield { type: "text", delta: "You'll need to connect Gmail first." };
      },
    });

    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      store,
      connectors: [connector],
      harness: harness as never,
    } as Parameters<typeof createVendo>[0]);

    const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thr_gate",
        message: { id: "m1", role: "user", parts: [{ type: "text", text: "email my invoices" }] },
      }),
    }));
    await response.text();
    expect(response.status).toBe(200);

    const turnId = seen[0];
    const rows = await auditRows(store);
    const gated = rows.filter((row) => row.outcome === "connect-required");
    expect(gated, "the gate reported its own tool-call row").toHaveLength(1);
    expect(gated[0]!.tool).toBe("gmail_GMAIL_SEND_EMAIL");
    expect(gated[0]!.turnId).toBe(turnId);
    // And the turn's OTHER rows agree with it, which is the whole point of a
    // join key: one turn, one id, every plane.
    expect(rows.filter((row) => row.turnId !== turnId)).toEqual([]);
  }, 60_000);

  it("mints a fresh id for the next turn on the same thread", async () => {
    const store = await tempStore();
    const seen: string[] = [];
    const harness = defineHarness({
      name: "turn-id-probe",
      async *run(turn) {
        seen.push(turn.turnId);
        yield { type: "text", delta: "ok" };
      },
    });
    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      store,
      harness: harness as never,
    } as Parameters<typeof createVendo>[0]);

    for (const id of ["m1", "m2"]) {
      const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: THREAD,
          message: { id, role: "user", parts: [{ type: "text", text: "hi" }] },
        }),
      }));
      await response.text();
    }

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  }, 60_000);
});

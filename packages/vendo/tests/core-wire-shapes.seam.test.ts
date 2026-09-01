/**
 * The shapes `@vendoai/vendo/ui` used to hand-copy, proven at the seam.
 *
 * ui is layered to `@vendoai/vendo/core` alone, so it could not name this package's
 * types and kept its own restatement of them instead — "verbatim from the
 * frozen contract text", which is a promise and not a mechanism. The copy of
 * `Thread` had lost `title` and `revision`, and the compile-time parity check
 * that was supposed to catch that could not: both missing fields were OPTIONAL,
 * so each declaration stayed assignable to the other and the gate stayed green
 * while a surface reading a thread through the client could see neither.
 *
 * Every shape now has ONE definition, in core, and both halves import it. That
 * is what these cases hold: the REAL door over a real store answering the REAL
 * `createVendoClient`, with the producer's own read alongside the client's for
 * the fields a copy is most likely to drop. `fetch` is the only double, and it
 * is a wire, not a fake.
 */
import { automationsInternals } from "../src/automations/index.js";
import { RUN_STATUSES, type AutomationId, type Principal, type RunContext } from "../src/core/index.js";
import { type VendoStore } from "../src/store/index.js";
import { emptySharedStore } from "../src/store/backends.test-util.js";
import { createVendoClient, type VendoClient } from "../src/ui/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedModel, textTurn } from "../src/agent-doubles.test-util.js";
import { createVendo, type Vendo } from "../src/server.js";

const BASE = "https://maple.test/api/vendo";
const principal: Principal = { kind: "user", subject: "user_shapes" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "session_shapes" };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function seam(turns = [textTurn("Here is your spending.")]): Promise<{ vendo: Vendo; client: VendoClient }> {
  const store: VendoStore = await emptySharedStore();
  const vendo = createVendo({
    models: { default: scriptedModel(turns) },
    principal: async () => principal,
    store,
    // A policy makes the guard's posture "rules" and makes an automation's
    // arming a real consent moment — both of which the shapes below carry.
    guard: { policy: { rules: [{ match: { risk: "read" }, action: "ask" }] } },
  });
  await store.ensureSchema();

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL
      ? String(input) : (input as { url: string }).url;
    return vendo.handler(new Request(url, init));
  }) as typeof fetch;
  cleanups.push(() => { globalThis.fetch = realFetch; });

  return { vendo, client: createVendoClient({ baseUrl: BASE }) };
}

describe("the wire shapes ui used to copy, read back through the shipped client", () => {
  it("hands the client the whole thread — the listing title and the store's revision included", async () => {
    const { vendo, client } = await seam();

    // WRITE through the real door: one real turn, persisted by the real
    // repository — which is what computes `title` and stamps `revision`.
    const stream = await client.threads.stream({
      threadId: "thr_shapes",
      message: { id: "msg_user", role: "user", parts: [{ type: "text", text: "show me my spending" }] },
    });
    await stream.text();

    // READ through the real client. These are the two fields the hand-copy had
    // dropped: a surface reading a thread through it saw neither.
    const thread = await client.threads.get("thr_shapes");
    expect(thread.title).toEqual(expect.any(String));
    expect(thread.title).not.toBe("");
    expect(thread.revision).toEqual(expect.any(String));
    expect(thread.revision).not.toBe("");

    // And the producer's own read agrees field-for-field. One definition means
    // the two cannot differ; before it, only this comparison could tell.
    expect(thread).toEqual(await vendo.harness.threads.get("thr_shapes", ctx));

    const [summary] = await client.threads.list();
    expect(summary).toMatchObject({ id: "thr_shapes", title: thread.title });
    expect(summary?.updatedAt).toEqual(expect.any(String));
  });

  it("hands the client the run ledger's shapes — the plan, the consent moment and the row", async () => {
    const { vendo, client } = await seam();
    vendo.actions.add({
      async descriptors() {
        return [{ name: "host_read_accounts", description: "Read the accounts", inputSchema: { type: "object" }, risk: "read" }];
      },
      async execute() { return { status: "ok", output: {} }; },
    });
    const record = await automationsInternals(vendo.automations).create({
      owner: principal,
      when: { event: "go" },
      task: { kind: "steps", steps: [{ id: "read", tool: "host_read_accounts" }] },
      authoredBy: "chat",
      armed: false,
    }, ctx);
    const id: AutomationId = record.id;

    // AutomationEntry — the record itself, with the secret the server redacts.
    const [entry] = await client.automations.list();
    expect(entry).toMatchObject({ id, armed: false, authoredBy: "chat" });
    expect(entry).not.toHaveProperty("webhookSecret");

    // RunPlan — what the dry run says it would do, and what it would have to ask.
    const plan = await client.automations.dryRun(id);
    expect(plan.steps).toEqual([{ id: "read", tool: "host_read_accounts", wouldAsk: true }]);
    expect(plan.grantsMissing).toContain("host_read_accounts");

    // EnableResult — the consent moment. Arming always takes (arming-surface.ts:62);
    // what the answer carries is what is still to be allowed, and the ONE set
    // the asks belong to, so a single decision settles them all.
    const asked = await client.automations.enable(id);
    expect(asked.enabled).toBe(true);
    expect(asked.missing.length).toBeGreaterThan(0);
    expect(asked.grantSetId).toEqual(expect.any(String));

    await vendo.guard.approvals.decide(asked.missing.map((ask) => ask.id), { approve: true }, principal);
    const armed = await client.automations.enable(id);
    expect(armed).toEqual({ enabled: true, missing: [] });

    // RunRecord — one real firing, read back off the one ledger.
    const [runId] = await vendo.automations.emit("go", {}, principal);
    const { runs } = await client.runs.list({ automationId: id });
    const run = runs.find((row) => row.id === runId);
    expect(run).toMatchObject({
      id: runId,
      automationId: id,
      owner: principal,
      trigger: { kind: "host-event", event: "go" },
    });
    expect(RUN_STATUSES).toContain(run?.status);
    expect(run?.steps.map((step) => step.tool)).toEqual(["host_read_accounts"]);
    expect(await client.runs.get(runId!)).toEqual(run);
  });

  it("hands the client the deployment's status — the guard's posture, verbatim", async () => {
    const { vendo, client } = await seam();
    const status = await client.status();

    expect(status.posture).toBe(vendo.guard.status().posture);
    expect(status.posture).toBe("rules");
    expect(status.version).toEqual(expect.any(String));
    expect(status.blocks).toMatchObject({ store: true, guard: true });
  });
});

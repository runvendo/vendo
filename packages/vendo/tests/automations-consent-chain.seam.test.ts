/**
 * THE WHOLE mid-run consent chain, over one real composition: a firing meets a
 * permission nobody granted and FAILS, one real tap on the real guard mints the
 * away authority, and `runs.rerun` spends it — proved by the HOST's own function
 * running, not by a status.
 *
 * Both halves of this were already proved, and neither could catch the other:
 * `packages/automations/tests/engine.test.ts` re-runs against a `GuardDouble`
 * whose `check()` always answers "run", so its `status: "ok"` says nothing about
 * authority, and `packages/guard/test/security/chat-grant-not-away.test.ts`
 * hand-seeds the grant shape it accepts. Here the guard that refuses the first
 * call is the guard that authorizes the second, and nothing between them is
 * stubbed: real `createVendo`, real guard, real automations engine, one real
 * store, and the host registry's own side effect as the evidence.
 *
 * There is no auto-resume, deliberately (`run-execution.ts`, `consent.ts` — the
 * run ends at the miss); `runs.rerun` is the whole remedy.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationsInternals } from "@vendoai/automations";
import type { Principal, RunContext, ToolRegistry } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const READ_TOOL = "host_readInvoices";
const owner: Principal = { kind: "user", subject: "nadia" };
const ctx: RunContext = {
  principal: owner,
  venue: "automation",
  presence: "away",
  sessionId: "sess_nadia",
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The composed host, and the ledger of what its OWN function was asked to do —
 *  the only witness that says a run really ran rather than merely said "ok". */
async function boot(): Promise<{ vendo: Vendo; calls: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "vendo-consent-chain-"));
  const store = createStore({ dataDir: join(root, "data") });
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const vendo = createVendo({ store, auth: { principal: async () => owner } });
  const calls: string[] = [];
  const tools: ToolRegistry = {
    async descriptors() {
      return [{ name: READ_TOOL, description: "Read the invoices", inputSchema: { type: "object" }, risk: "read" }];
    },
    async execute(call) {
      calls.push(call.tool);
      return { status: "ok", output: { invoices: [] } };
    },
  };
  vendo.actions.add(tools);
  await store.ensureSchema();
  return { vendo, calls };
}

describe.sequential("CHECK: a mid-firing tap is the away authority the re-run spends", () => {
  it("parks and fails, mints one automation grant from the real decision, then really calls the host", async () => {
    const { vendo, calls } = await boot();
    const record = await automationsInternals(vendo.automations).create({
      owner,
      when: { event: "invoice.paid" },
      task: { kind: "steps", steps: [{ id: "read", tool: READ_TOOL }] },
      authoredBy: "chat",
    }, ctx);

    // Armed, and holding nothing: the away downgrade forces an ask, the run
    // parks its capture and ends LOUDLY.
    const [runId] = await vendo.emit("invoice.paid", {}, owner);
    expect(await vendo.automations.runs.get(runId!, ctx)).toMatchObject({
      automationId: record.id,
      status: "error",
      error: { code: "needs-permission", tool: READ_TOOL },
    });
    // The refusal was real: the host's own function was never reached.
    expect(calls).toEqual([]);

    // The ask the FIRING raised, read back off the guard's own pending feed.
    const pending = await vendo.guard.approvals.pending(owner);
    expect(pending.map((ask) => ask.ctx.trigger?.automationId)).toEqual([record.id]);

    // One tap. `{ approve: true }` and nothing else — exactly what the consent
    // card sends, so the guard's own remembered-grant arm never runs and the
    // automations engine's decision subscriber is the only minter.
    await vendo.guard.approvals.decide([pending[0]!.id], { approve: true }, owner);

    const grants = await vendo.guard.grants.list(owner);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      subject: owner.subject,
      tool: READ_TOOL,
      automationId: record.id,
      source: "automation",
      duration: "standing",
      scope: { kind: "tool" },
    });
    // The record's own id is the WHOLE away match (`presenceMatches` in
    // `packages/guard/src/guard.ts`): an automation carries no app reference at
    // all, so the rerun below is authorized with NO `appId` on the grant. Pinned
    // so this stays specifically the automations rule and can never quietly
    // absorb the boxed-app case, which is a different question with its own fix.
    expect(grants[0]!.appId).toBeUndefined();

    // A FRESH run of the same firing, and the same guard now says run.
    const rerunId = await vendo.automations.runs.rerun(runId!, ctx);
    expect(await vendo.automations.runs.get(rerunId, ctx)).toMatchObject({
      automationId: record.id,
      status: "ok",
    });
    // THE point: a status of "ok" with the tool never called would be the same
    // lie in a new costume.
    expect(calls).toEqual([READ_TOOL]);
    // The failed run is left as the record of what happened.
    expect(await vendo.automations.runs.get(runId!, ctx)).toMatchObject({ status: "error" });
  });
});

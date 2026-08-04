/**
 * THE LAW's PROJECTION (design §12) must hold on the BYO door.
 *
 * `vendo.guardedTools` is the public registry the BYO packs execute through —
 * `toVendoAiSdkTools` and the mastra pack both hand it straight to a foreign
 * agent loop. It is assembled from `createByoApprovals().registry`, which
 * re-declared `descriptors()` with NO parameter and so silently swallowed the
 * projection context: `guard.bind` returns the FULL set when it is given no ctx,
 * so every destructive tool stayed visible to an unattended run.
 *
 * The execute-time refusal still held, so this was never an escape — but "the
 * model is never even offered it" is the property §12 buys, and it was absent on
 * this door. This is the identical bug the connect gate had
 * (`law-projection.e2e.test.ts`), one seam further out, which is why it is
 * asserted here through a REAL `createVendo` rather than a hand-built stack.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, RunContext } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_byo_law" };

const routeTool = (name: string, method: "GET" | "POST", risk: "read" | "write" | "destructive") => ({
  name,
  description: `host tool ${name}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  risk,
  binding: { kind: "route" as const, method, path: `/api/${name}`, argsIn: "query" as const },
});

/** Plainly labelled tools: this door's bug is about the CTX, not the vote, so
 *  nothing here needs the mechanical vote to reach the right answer. */
const PROFILE = {
  tools: [
    routeTool("maple_invoices_list", "GET", "read"),
    routeTool("maple_invoice_update", "POST", "write"),
    routeTool("maple_payments_send", "POST", "destructive"),
  ],
};

const away: RunContext = {
  principal,
  venue: "automation",
  presence: "away",
  sessionId: "sess_byo_law_1",
  appId: "app_byo_law" as never,
  trigger: { kind: "schedule", runId: "run_byo_law_1" as never },
};

const present: RunContext = {
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "sess_byo_law_2",
};

async function compose(): Promise<Vendo> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-byo-law-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    profile: PROFILE as never,
  } as Parameters<typeof createVendo>[0]);
  await store.ensureSchema();
  return vendo;
}

const namesFor = async (ctx?: RunContext): Promise<string[]> =>
  (await (await compose()).guardedTools.descriptors(ctx)).map((descriptor) => descriptor.name);

describe("THE LAW's projection reaches the BYO door (vendo.guardedTools)", () => {
  it("withholds a destructive tool from an unattended run", async () => {
    expect(await namesFor(away)).not.toContain("maple_payments_send");
  });

  it("still offers the reads and writes that same run is entitled to", async () => {
    const names = await namesFor(away);

    expect(names).toContain("maple_invoices_list");
    expect(names).toContain("maple_invoice_update");
  });

  it("offers the destructive tool when a person is present", async () => {
    expect(await namesFor(present)).toContain("maple_payments_send");
  });

  it("offers everything when no context is given, so unrelated callers are unaffected", async () => {
    expect(await namesFor()).toContain("maple_payments_send");
  });
});

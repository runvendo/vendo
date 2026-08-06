/**
 * D5 — `vendo_delegate` runs on the composed away runner, not on a second engine.
 *
 * The behaviour that proves the swap is PERSISTENCE: `createAgent`'s mini-loop
 * was a stateless `generateText` that left nothing behind, while a harness run
 * mints a thread and writes its transcript. So the check is the store, read back
 * through the real read path — a delegation now has a `thr_*` row with the
 * delegated task in it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel, Tool, ToolCallOptions } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { vendoTools } from "./ai-sdk.js";
import { createVendo, type CreateVendoConfig } from "./server.js";
import { VENDO_DELEGATE_TOOL } from "./tool-pack.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_delegate" };

const model = {
  specificationVersion: "v2",
  provider: "vendo-delegate",
  modelId: "vendo-delegate-v1",
  supportedUrls: {},
  async doStream() {
    return { stream: new ReadableStream({ start: (controller) => controller.close() }) };
  },
} as unknown as LanguageModel;

/** The deployment's brain, scripted: it reports what it was asked to do. */
const reporting = defineHarness({
  name: "delegate-probe",
  async *run(turn) {
    const asked = turn.messages.at(-1)?.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("") ?? "";
    yield { type: "text", delta: `Summary: handled "${asked}".` };
  },
});

/** A store the way a HOST supplies one: the whole public `VendoStore` surface,
 *  delegating to a real store so records and blobs genuinely work — but not the
 *  handle `@vendoai/store` minted, so it has no SQL tables and no StoreOps.
 *  `storeServesHarnessTurns` answers false for it. */
function nonSqlStore(backing: VendoStore): VendoStore {
  return {
    records: (collection) => backing.records(collection),
    blobs: (namespace) => backing.blobs(namespace),
    ensureSchema: () => backing.ensureSchema(),
    close: () => backing.close(),
    raw: () => backing.raw(),
  };
}

async function compose(
  wrap: (store: VendoStore) => VendoStore = (store) => store,
): Promise<{ store: VendoStore; tools: Record<string, Tool> }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-delegate-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  await store.ensureSchema();
  const vendo = createVendo({
    model,
    principal: async () => principal,
    store: wrap(store),
    harness: reporting as never,
  } as CreateVendoConfig);
  return { store, tools: await vendoTools(vendo, { principal }) };
}

describe("vendo_delegate rides the composed away runner", () => {
  it("leaves a persisted thr_* thread behind, carrying the delegated task", async () => {
    const { store, tools } = await compose();
    const delegate = tools[VENDO_DELEGATE_TOOL];
    expect(delegate).toBeDefined();

    const result = await delegate?.execute?.(
      { task: "reconcile the July invoices" },
      { toolCallId: "call_delegate", messages: [] } as ToolCallOptions,
    ) as { status: string; summary: string };

    expect(result.status).toBe("ok");
    // The model's own closing account, read back off the persisted turn.
    expect(result.summary).toContain("reconcile the July invoices");

    // The real read path: a thread row and its message rows, both written by the
    // harness runtime. The legacy mini-loop wrote neither.
    const raw = store.raw() as { query<T>(text: string): Promise<{ rows: T[] }> };
    const threads = await raw.query<{ id: string }>("SELECT id FROM vendo_threads");
    expect(threads.rows).toHaveLength(1);
    expect(threads.rows[0]?.id).toMatch(/^thr_/);

    const messages = await raw.query<{ message: unknown }>(
      "SELECT message FROM vendo_thread_messages ORDER BY seq",
    );
    expect(JSON.stringify(messages.rows)).toContain("reconcile the July invoices");
  });

  /** The runner is a harness turn, so it needs what a harness turn needs. A host
   *  store that serves neither Vendo's tables nor the operation contract used to
   *  get a delegate tool that threw on its first line, which the pack rendered as
   *  "the delegated run could not be completed": a sentence that sends the host
   *  hunting a bug in their task. */
  it("answers with the real reason on a store that cannot serve a harness turn", async () => {
    const { tools } = await compose(nonSqlStore);
    const delegate = tools[VENDO_DELEGATE_TOOL];

    const result = await delegate?.execute?.(
      { task: "reconcile the July invoices" },
      { toolCallId: "call_delegate", messages: [] } as ToolCallOptions,
    ) as { status: string; summary: string };

    expect(result.status).toBe("error");
    expect(result.summary).toContain("cannot serve a harness turn");
    expect(result.summary).not.toContain("could not be completed");
  });
});

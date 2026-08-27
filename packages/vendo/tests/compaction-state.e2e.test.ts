/**
 * The compaction state SEAM — one write path, one read path, no stub on either.
 *
 * Compaction only converges if what one turn stored is what the next turn builds
 * its prompt from, and that crosses four owners to get there: `vendo()` writes it
 * into `turn.state`, the harness runtime buffers it and saves it at turn end
 * (`runtime.ts` `onFinish` → `saveHarnessState`), the REAL
 * `harnessStateStore(store)` puts it on the thread's own row
 * (`vendo_threads.harness_state`), and the next turn's projection reads it back. A suite that mocked the store would let the writer and
 * the reader agree about a shape neither ships, which is exactly the failure this
 * repo has already paid for once.
 *
 * So both halves run for real, through `createVendo`'s own door, over a real
 * PGlite store. The read half is proven by DIFFERENCE rather than by inspection:
 * two identical second turns, one with the slot intact and one with the slot
 * cleared through the same real store, must project differently — the summary
 * stands in for the band it absorbed in one and the band is re-summarized in the
 * other. A read that never reached the projection would make both turns identical.
 *
 * The slot carries a SUMMARY and the boundary it absorbed. It used to carry the
 * provider's reported prompt count as well, and that was the wrong kind of fact to
 * persist: a count describes the prompt a turn SENT, while the next turn's trigger
 * asks about what the thread STORES, and after a compaction those are different
 * sizes.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { vendo as vendoHarness } from "@vendoai/harnesses";
import { readCompactionState } from "@vendoai/harnesses/vendo";
import { createStore, harnessStateStore, type VendoStore } from "@vendoai/store";
import type { UIMessage } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type CreateVendoConfig, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_compaction_state" };

/** Two markers, so a projection can be read off the wire without counting. */
const OLDEST = "OLDEST-JAN-TRANSFER";
const NEWEST = "NEWEST-ASK";
/** Big enough to outgrow the 20,000-token verbatim tail a compaction always
 *  preserves, so there is something for the cut to put ABOVE it. 200,000
 *  characters is 100,000 tokens in the engine's one conversion. */
const BULK = "b".repeat(200_000);

/** The window this deployment claims — small enough that the bulk trips it. */
const TINY_WINDOW = 2_000;
/** What the provider "reports" per step. Nothing reads it as a decision any more;
 *  it is the usage event's and the audit ledger's. */
const MEASURED_PROMPT_TOKENS = 120;

/** What the summarizer returns, so the band it absorbs is identifiable on the wire
 *  and in the row. */
const SUMMARY_MARKER = "SUMMARY-OF-JAN-TRANSFER";

/** A model that answers in one word, and summarizes when the loop asks it to. */
function reportingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: `## Goal\n${SUMMARY_MARKER}` }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    }),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "ok" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            usage: {
              inputTokens: {
                total: MEASURED_PROMPT_TOKENS,
                noCache: MEASURED_PROMPT_TOKENS,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            finishReason: { unified: "stop" as const, raw: undefined },
          },
        ],
      }),
    }),
  });
}

const hostTools = (): ToolRegistry => {
  const descriptor: ToolDescriptor = {
    name: "maple_listAccounts",
    title: "List accounts",
    description: "List the signed-in customer's accounts",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  };
  return {
    async descriptors() {
      return [descriptor];
    },
    async execute() {
      return { status: "ok", output: { accounts: [] } };
    },
  };
};

interface Composed {
  vendo: Vendo;
  store: VendoStore;
  model: MockLanguageModelV3;
  chat: (threadId: string, id: string, text: string) => Promise<void>;
}

async function compose(): Promise<Composed> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-compaction-state-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  const model = reportingModel();
  const vendo = createVendo({
    models: { default: model as never },
    principal: async () => principal,
    store,
    // Q1a: the window override lives on the HARNESS, never on `createVendo`.
    harness: vendoHarness({ contextWindowTokens: TINY_WINDOW }) as never,
  } as CreateVendoConfig);
  vendo.actions.add(hostTools());
  const chat = async (threadId: string, id: string, text: string): Promise<void> => {
    const message: UIMessage = { id, role: "user", parts: [{ type: "text", text }] };
    const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, message }),
    }));
    await response.text();
  };
  return { vendo, store, model, chat };
}

/** The prompt of the call that carried `marker`, as sent to the provider. */
function promptCarrying(model: MockLanguageModelV3, marker: string): string {
  const call = [...model.doStreamCalls].reverse().find((entry) => JSON.stringify(entry.prompt).includes(marker));
  expect(call, `no provider call carried ${marker}`).toBeDefined();
  return JSON.stringify(call?.prompt);
}

describe("the compaction slot, written and read through the real store", () => {
  it("writes the summary AND the boundary it absorbed into the thread's own slot", async () => {
    const { store, chat } = await compose();
    await chat("thr_state_write", "m1", `${OLDEST} ${BULK}`);
    await chat("thr_state_write", "m2", NEWEST);

    // A FRESH handle over the same store — the runtime's own instance is not
    // reused, so nothing but the row can be carrying the value.
    const slot = await harnessStateStore(store).get("thr_state_write", "vendo");
    expect(slot, "the turn wrote no harness state at all").toBeDefined();
    expect(readCompactionState(slot)).toEqual({
      version: 1,
      summary: `## Goal\n${SUMMARY_MARKER}`,
      // The pair is the point. A summary without the id it absorbed cannot be
      // reused — the next turn cannot tell which messages it stands in for — so
      // the projection discards it and re-summarizes the whole transcript, which
      // is the every-turn summarizer pass this boundary exists to end.
      boundaryMessageId: "m1",
    });
  });

  it("keeps the slot out of another harness's reach", async () => {
    // §1.3's clearing rule, on the real row: the state belongs to `vendo`, and a
    // different thinker asking for it gets nothing.
    const { store, chat } = await compose();
    await chat("thr_state_owner", "m1", `${OLDEST} ${BULK}`);
    expect(await harnessStateStore(store).get("thr_state_owner", "claude-code")).toBeUndefined();
  });

  it("feeds the NEXT turn's projection: the stored summary stands in for the band", async () => {
    const { model, chat } = await compose();
    const threadId = "thr_state_read";
    await chat(threadId, "m1", `${OLDEST} ${BULK}`);
    await chat(threadId, "m2", NEWEST);
    await chat(threadId, "m3", "and after that?");

    // Turn 2 absorbed the bulk. Turn 3 reads that summary back out of the row and
    // projects it IN PLACE of the band, rather than re-reading the band itself.
    const prompt = promptCarrying(model, "and after that?");
    expect(prompt).toContain(SUMMARY_MARKER);
    expect(prompt).not.toContain(OLDEST);
    // ONE pass across three turns: turn 3 reused what turn 2 stored. A second pass
    // would mean the row round-tripped and bought nothing — which is the whole
    // difference between compaction and paying for the context twice.
    expect(model.doGenerateCalls.length, "the stored summary was not reused").toBe(1);
  });

  it("…and re-summarizes once the slot is gone — the read really is what changed", async () => {
    const { store, model, chat } = await compose();
    const threadId = "thr_state_cleared";
    await chat(threadId, "m1", `${OLDEST} ${BULK}`);
    await chat(threadId, "m2", NEWEST);
    expect(model.doGenerateCalls.length).toBe(1);
    // Cleared through the SAME real store the runtime writes to. Nothing else
    // about the third turn differs.
    await harnessStateStore(store).clear(threadId);
    await chat(threadId, "m3", "and after that?");

    // With nothing to reuse, turn 3 pays for its own pass over the whole thread.
    expect(model.doGenerateCalls.length).toBe(2);
  });
});

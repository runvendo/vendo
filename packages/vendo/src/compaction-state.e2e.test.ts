/**
 * The compaction state SEAM — one write path, one read path, no stub on either.
 *
 * The loop's estimate is only as good as the number it carries between turns, and
 * that number crosses four owners to get there: `vendo()` writes it into
 * `turn.state`, the harness runtime buffers it and saves it at turn end
 * (`runtime.ts` `onFinish` → `saveHarnessState`), the REAL
 * `harnessStateStore(store)` puts it in `vendo_state`, and the next turn's
 * projection reads it back. A suite that mocked the store would let the writer and
 * the reader agree about a shape neither ships, which is exactly the failure this
 * repo has already paid for once.
 *
 * So both halves run for real, through `createVendo`'s own door, over a real
 * PGlite store. The read half is proven by DIFFERENCE rather than by inspection:
 * two identical second turns, one with the slot intact and one with the slot
 * cleared through the same real store, must project differently — because the
 * measured number says the thread fits and the guess says it does not. A read that
 * never reached the projection would make both turns identical.
 *
 * In S2 the slot carries `lastPromptTokens`. The summary field arrives with the
 * summarizer in S3; this asserts what S2 actually writes.
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
import { createVendo, type CreateVendoConfig, type Vendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_compaction_state" };

/** Two markers, so a projection can be read off the wire without counting. */
const OLDEST = "OLDEST-JAN-TRANSFER";
const NEWEST = "NEWEST-ASK";
/** Big enough that the four-characters-per-token guess is worth ~5k tokens. */
const BULK = "b".repeat(20_000);

/** The window this deployment claims — small enough that 5k tokens trips it. */
const TINY_WINDOW = 2_000;
/** What the provider "reports" for the first turn: the truth the guess misses. */
const MEASURED_PROMPT_TOKENS = 120;

/** A model that answers in one word and reports a prompt count the guess cannot
 *  reach on its own — the whole point of preferring the provider's number. */
function reportingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
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
    model: model as never,
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
  const call = model.doStreamCalls.findLast((entry) => JSON.stringify(entry.prompt).includes(marker));
  expect(call, `no provider call carried ${marker}`).toBeDefined();
  return JSON.stringify(call?.prompt);
}

describe("the compaction slot, written and read through the real store", () => {
  it("writes the provider's prompt count into the thread's own slot", async () => {
    const { store, chat } = await compose();
    await chat("thr_state_write", "m1", `${OLDEST} ${BULK}`);

    // A FRESH handle over the same store — the runtime's own instance is not
    // reused, so nothing but the row can be carrying the value.
    const slot = await harnessStateStore(store).get("thr_state_write", "vendo");
    expect(slot, "the turn wrote no harness state at all").toBeDefined();
    expect(readCompactionState(slot)).toEqual({
      version: 1,
      lastPromptTokens: MEASURED_PROMPT_TOKENS,
      // Where the thread stood when this was written, so a later turn can tell
      // that it still stands there. Round 2: a state the thread has been rewound
      // past describes a branch that no longer exists, and is discarded.
      coveredThroughMessageId: "m1",
    });
  });

  it("keeps the slot out of another harness's reach", async () => {
    // §1.3's clearing rule, on the real row: the state belongs to `vendo`, and a
    // different thinker asking for it gets nothing.
    const { store, chat } = await compose();
    await chat("thr_state_owner", "m1", `${OLDEST} ${BULK}`);
    expect(await harnessStateStore(store).get("thr_state_owner", "claude-code")).toBeUndefined();
  });

  it("feeds the NEXT turn's projection: the measured number keeps history the guess would shed", async () => {
    const { model, chat } = await compose();
    const threadId = "thr_state_read";
    await chat(threadId, "m1", `${OLDEST} ${BULK}`);
    await chat(threadId, "m2", NEWEST);

    // 20k characters guess at ~5k tokens, well over 0.81 × 2_000 — so without the
    // slot the second turn sheds the oldest message. With it, the provider's own
    // 120 says the thread fits, and the history survives.
    expect(promptCarrying(model, NEWEST)).toContain(OLDEST);
  });

  it("…and sheds it once the slot is gone — the read really is what changed", async () => {
    const { store, model, chat } = await compose();
    const threadId = "thr_state_cleared";
    await chat(threadId, "m1", `${OLDEST} ${BULK}`);
    // Cleared through the SAME real store the runtime writes to. Nothing else
    // about the second turn differs.
    await harnessStateStore(store).clear(threadId);
    await chat(threadId, "m2", NEWEST);

    expect(promptCarrying(model, NEWEST)).not.toContain(OLDEST);
  });
});

/**
 * A `@vendoai/store` older than `upsertMany` must make a turn SLOWER, not
 * broken.
 *
 * `harness-turn` calls the batch verb on every turn after the first, and it
 * used to call it unconditionally while `persistTurn` in `@vendoai/harnesses`
 * guarded the same verb — one call site protected, one not, which reads as
 * protection that is not there. A store without the verb then failed on turn
 * TWO of a conversation, after the first turn had already worked.
 *
 * The old store is spelled the way one actually behaves: the REAL transcript
 * door with exactly that one method absent. Everything else — the composition,
 * the model turn, the store the messages land in and are read back from — is
 * real, so this cannot pass by agreeing with a stub.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptedModel, textTurn } from "../src/agent-doubles.test-util.js";
import { createVendo, type CreateVendoConfig } from "../src/server.js";

/** The store as it shipped BEFORE the batch verb: every real door, minus the
 *  one method. `importOriginal` keeps this a subtraction from the shipped
 *  implementation rather than a re-implementation of it. */
vi.mock("@vendoai/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vendoai/store")>();
  return {
    ...actual,
    threadMessageStore: (store: Parameters<typeof actual.threadMessageStore>[0]) => {
      const { upsertMany: _absent, ...older } = actual.threadMessageStore(store);
      return older;
    },
  };
});

const principal: Principal = { kind: "user", subject: "user_batch_fallback" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("a store older than upsertMany", () => {
  it("still lands turn two, through the path that predates the verb", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-batch-fallback-"));
    const store = createStore({ dataDir });
    cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
    await store.ensureSchema();
    const vendo = createVendo({
      models: { default: scriptedModel([textTurn("one"), textTurn("two")]) as unknown as LanguageModel },
      principal: async () => principal,
      store,
    } as CreateVendoConfig);

    const thread = "thr_batch_fallback";
    const say = async (text: string): Promise<Response> => {
      const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: thread,
          message: { id: `m_${text}`, role: "user", parts: [{ type: "text", text }] },
        }),
      }));
      await response.text();
      return response;
    };

    // Turn one creates the row and never reaches the batch verb; turn two is
    // the call site that used to hard-fail.
    expect((await say("first")).status).toBe(200);
    expect((await say("second")).status).toBe(200);

    // Read back through the REAL store: both turns are in the conversation, in
    // the order they were said.
    const listed = await vendo.harness.threads.get(thread, {
      principal, venue: "chat", presence: "present", sessionId: "s_fallback",
    });
    const said = (listed?.messages ?? [])
      .filter((message) => message.role === "user")
      .map((message) => message.id);
    expect(said).toEqual(["m_first", "m_second"]);
  });
});

/**
 * The per-turn refusal must not be a HALF-write.
 *
 * A store that offers neither a SQL handle nor a StoreOps surface (a host's own
 * adapter behind the public `VendoStore` surface) cannot keep the transcript and
 * the workspace, so `POST /threads` refuses the turn — that part is proven in
 * `harness-wire.test.ts`. What is NOT proven there is that the refusal leaves
 * the store as it found it.
 *
 * It does not. `createHarnessTurns().stream` resolves the thread and calls
 * `threads.persist(thread, [message])` — which goes through the adapter seam and
 * therefore SUCCEEDS on this store — before it ever asks for the transcript /
 * workspace doors (`sqlDoors()`), which is where the refusal is raised. So every
 * refused turn silently lands a `vendo_threads` row carrying the user's message
 * on a deployment that can never answer it, and a client that keeps retrying
 * keeps growing that thread.
 *
 * (harness-turn.ts: `await threads.persist(...)` runs before
 *  `const { transcript, workspaces, harnessState } = sqlDoors();`)
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { defineHarness } from "@vendoai/harnesses";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_refusal" };

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-refusal-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** The public surface only — no SQL handle in @vendoai/store's WeakMap, no
 *  `ops`. Records and blobs really work, which is the whole point: the write
 *  below is not blocked by a broken store, it is simply never rolled back. */
function nonSqlStore(backing: VendoStore): VendoStore {
  return {
    records: (collection) => backing.records(collection),
    blobs: (namespace) => backing.blobs(namespace),
    ensureSchema: () => backing.ensureSchema(),
    close: () => backing.close(),
    raw: () => backing.raw(),
  };
}

const request = (body: unknown): Request =>
  new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const userMessage = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

describe("the no-SQL/no-ops refusal is atomic", () => {
  it("writes nothing to the store when it refuses the turn", async () => {
    const backing = await tempStore();
    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      store: nonSqlStore(backing),
      harness: defineHarness({
        name: "scripted",
        // eslint-disable-next-line require-yield
        run: async function* () {
          throw new Error("the harness must never run on a store that cannot serve it");
        },
      }) as never,
    } as Parameters<typeof createVendo>[0]);

    const turn = await vendo.handler(request({
      threadId: "thr_refused",
      message: userMessage("m1", "hello"),
    }));
    expect(turn.status).toBe(501);

    // The refusal is the whole outcome: no thread row, and so no copy of the
    // user's message, on a deployment that can never answer it.
    const { records } = await backing.records("vendo_threads").list({
      refs: { subject: principal.subject },
    });
    expect(records).toEqual([]);
    expect(await backing.records("vendo_threads").get("thr_refused")).toBeNull();
  });
});

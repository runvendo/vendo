/**
 * DrizzleThreadStore contract tests — a durable port of the core `ThreadStore`
 * seam (packages/flowlet-core/src/seams/store.ts), behavioral spec =
 * InMemoryThreadStore (packages/flowlet-runtime/src/embedded/in-memory-store.ts)
 * and its test suite. Additions here are DB-specific: race-safe seq
 * allocation via `threads.nextSeq` and a concurrent-upsert race test.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { FlowletUIMessage, Principal } from "@flowlet/core";
import { createFlowletDatabase, migrateFlowletDatabase, type FlowletDb } from "./db.js";
import { createDrizzleThreadStore } from "./thread-store.js";
import { threadMessages } from "./schema.js";

const NOW = "2026-07-02T00:00:00.000Z";
const scope: Principal = { tenantId: "t1", subject: "u1" };
const other: Principal = { tenantId: "t1", subject: "u2" };

const msg = (id: string, parts: unknown[] = []): FlowletUIMessage =>
  ({ id, role: "user", parts }) as FlowletUIMessage;

let suffix = 0;
function uniqueDataDir(): string {
  suffix += 1;
  return `memory://thread-store-test-${Date.now()}-${suffix}`;
}

let handle: FlowletDb;
let store: ReturnType<typeof createDrizzleThreadStore>;

beforeAll(async () => {
  handle = await createFlowletDatabase({ pglite: { dataDir: uniqueDataDir() } });
  await migrateFlowletDatabase(handle);
});

beforeEach(async () => {
  await handle.db.execute(sql`truncate table flowlet.thread_messages, flowlet.threads`);
  store = createDrizzleThreadStore(handle, { now: () => NOW });
});

describe("create/get/list", () => {
  it("creates threads with store-owned id + timestamps and lists per scope", async () => {
    const thread = await store.create(scope, { title: "Spending" });
    expect(thread.id).toBeTruthy();
    expect(thread.createdAt).toBe(NOW);
    expect(thread.tenantId).toBe("t1");
    expect(await store.list(scope)).toHaveLength(1);
    expect(await store.list(other)).toHaveLength(0);
    expect(await store.get(other, thread.id)).toBeUndefined();
  });
});

describe("appendMessages/getMessages", () => {
  it("appends and reads back messages in order", async () => {
    const thread = await store.create(scope);
    await store.appendMessages(scope, thread.id, [msg("m1")]);
    await store.appendMessages(scope, thread.id, [msg("m2")]);
    const messages = await store.getMessages(scope, thread.id);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(await store.getMessages(other, thread.id)).toEqual([]);
  });

  it("rejects appends to a thread that does not exist in scope", async () => {
    await expect(store.appendMessages(scope, "nope", [])).rejects.toThrow(/unknown thread/i);
  });
});

describe("upsertMessages", () => {
  it("inserts new messages and reads them back in order", async () => {
    const thread = await store.create(scope);
    await store.upsertMessages(scope, thread.id, [msg("m1"), msg("m2")]);
    const messages = await store.getMessages(scope, thread.id);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("re-upserting an existing id replaces parts wholesale and keeps position", async () => {
    const thread = await store.create(scope);
    await store.upsertMessages(scope, thread.id, [
      msg("m1", [{ type: "text", text: "stale approval" }]),
      msg("m2", [{ type: "text", text: "unchanged" }]),
    ]);
    await store.upsertMessages(scope, thread.id, [
      msg("m1", [{ type: "text", text: "resolved approval" }]),
    ]);
    const messages = await store.getMessages(scope, thread.id);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "resolved approval" }]);
    expect(messages[1]?.parts).toEqual([{ type: "text", text: "unchanged" }]);
  });

  it("auto-creates unknown threads (the client owns thread ids)", async () => {
    await store.upsertMessages(scope, "client-thread-1", [msg("m1")]);
    const thread = await store.get(scope, "client-thread-1");
    expect(thread?.id).toBe("client-thread-1");
    expect(thread?.tenantId).toBe("t1");
    const messages = await store.getMessages(scope, "client-thread-1");
    expect(messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("isolates identical client thread ids across principals", async () => {
    await store.upsertMessages(scope, "shared", [msg("m1", [{ type: "text", text: "mine" }])]);
    await store.upsertMessages(other, "shared", [msg("m1", [{ type: "text", text: "theirs" }])]);
    const mine = await store.getMessages(scope, "shared");
    const theirs = await store.getMessages(other, "shared");
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0]?.parts).toEqual([{ type: "text", text: "mine" }]);
    expect(theirs[0]?.parts).toEqual([{ type: "text", text: "theirs" }]);
  });

  it("two parallel upserts of DIFFERENT messages get distinct seqs with no unique violation", async () => {
    const thread = await store.create(scope);
    await Promise.all([
      store.upsertMessages(scope, thread.id, [msg("m1")]),
      store.upsertMessages(scope, thread.id, [msg("m2")]),
    ]);
    const messages = await store.getMessages(scope, thread.id);
    expect(messages.map((m) => m.id).sort()).toEqual(["m1", "m2"]);

    const rows = await handle.db
      .select({ messageId: threadMessages.messageId, seq: threadMessages.seq })
      .from(threadMessages)
      .where(and(eq(threadMessages.tenantId, scope.tenantId), eq(threadMessages.subject, scope.subject), eq(threadMessages.threadId, thread.id)));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.seq).not.toBe(rows[1]?.seq);
  });
});

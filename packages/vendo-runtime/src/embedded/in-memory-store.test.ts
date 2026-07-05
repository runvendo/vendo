import { describe, expect, it } from "vitest";
import type { Principal } from "@vendoai/core";
import { createInMemoryStore } from "./in-memory-store.js";

const scope: Principal = { tenantId: "t1", subject: "u1" };
const other: Principal = { tenantId: "t1", subject: "u2" };
const now = () => "2026-07-02T00:00:00.000Z";

describe("InMemoryThreadStore", () => {
  it("creates threads with store-owned id + timestamps and lists per scope", async () => {
    const store = createInMemoryStore({ now });
    const thread = await store.threads.create(scope, { title: "Spending" });
    expect(thread.id).toBeTruthy();
    expect(thread.createdAt).toBe(now());
    expect(thread.tenantId).toBe("t1");
    expect(await store.threads.list(scope)).toHaveLength(1);
    expect(await store.threads.list(other)).toHaveLength(0);
    expect(await store.threads.get(other, thread.id)).toBeUndefined();
  });

  it("appends and reads back messages in order", async () => {
    const store = createInMemoryStore({ now });
    const thread = await store.threads.create(scope);
    const msg = (id: string) => ({ id, role: "user", parts: [] }) as never;
    await store.threads.appendMessages(scope, thread.id, [msg("m1")]);
    await store.threads.appendMessages(scope, thread.id, [msg("m2")]);
    const messages = await store.threads.getMessages(scope, thread.id);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(await store.threads.getMessages(other, thread.id)).toEqual([]);
  });

  it("rejects appends to a thread that does not exist in scope", async () => {
    const store = createInMemoryStore({ now });
    await expect(store.threads.appendMessages(scope, "nope", [])).rejects.toThrow(
      /unknown thread/i,
    );
  });

  it("replaceMessages swaps the FULL list (continuation turns revise the trailing message)", async () => {
    const store = createInMemoryStore({ now });
    const thread = await store.threads.create(scope);
    const msg = (id: string, extra = {}) => ({ id, role: "assistant", parts: [], ...extra }) as never;
    await store.threads.appendMessages(scope, thread.id, [msg("u1"), msg("a1")]);
    // Same length, revised trailing message — the case appendMessages can't express.
    const revised = [msg("u1"), msg("a1", { metadata: { revised: true } })];
    await store.threads.replaceMessages(scope, thread.id, revised);
    const messages = await store.threads.getMessages(scope, thread.id);
    expect(messages).toHaveLength(2);
    expect((messages[1] as { metadata?: { revised?: boolean } }).metadata?.revised).toBe(true);
    await expect(store.threads.replaceMessages(other, thread.id, [])).rejects.toThrow(
      /unknown thread/i,
    );
  });
});

describe("InMemoryThreadStore.upsertMessages", () => {
  const msg = (id: string, parts: unknown[] = []) => ({ id, role: "user", parts }) as never;

  it("inserts new messages and reads them back in order", async () => {
    const store = createInMemoryStore({ now });
    const thread = await store.threads.create(scope);
    await store.threads.upsertMessages(scope, thread.id, [msg("m1"), msg("m2")]);
    const messages = await store.threads.getMessages(scope, thread.id);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("re-upserting an existing id replaces parts wholesale and keeps position", async () => {
    const store = createInMemoryStore({ now });
    const thread = await store.threads.create(scope);
    await store.threads.upsertMessages(scope, thread.id, [
      msg("m1", [{ type: "text", text: "stale approval" }]),
      msg("m2", [{ type: "text", text: "unchanged" }]),
    ]);
    // ai-SDK resume mutates message parts in place (ENG-204): the re-upsert
    // must replace m1's parts wholesale, not merge or duplicate the message.
    await store.threads.upsertMessages(scope, thread.id, [
      msg("m1", [{ type: "text", text: "resolved approval" }]),
    ]);
    const messages = await store.threads.getMessages(scope, thread.id);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "resolved approval" }]);
    expect(messages[1]?.parts).toEqual([{ type: "text", text: "unchanged" }]);
  });

  it("auto-creates unknown threads (the client owns thread ids)", async () => {
    const store = createInMemoryStore({ now });
    await store.threads.upsertMessages(scope, "client-thread-1", [msg("m1")]);
    const thread = await store.threads.get(scope, "client-thread-1");
    expect(thread?.id).toBe("client-thread-1");
    expect(thread?.tenantId).toBe("t1");
    const messages = await store.threads.getMessages(scope, "client-thread-1");
    expect(messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("isolates identical client thread ids across principals", async () => {
    const store = createInMemoryStore({ now });
    await store.threads.upsertMessages(scope, "shared", [
      msg("m1", [{ type: "text", text: "mine" }]),
    ]);
    await store.threads.upsertMessages(other, "shared", [
      msg("m1", [{ type: "text", text: "theirs" }]),
    ]);
    const mine = await store.threads.getMessages(scope, "shared");
    const theirs = await store.threads.getMessages(other, "shared");
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0]?.parts).toEqual([{ type: "text", text: "mine" }]);
    expect(theirs[0]?.parts).toEqual([{ type: "text", text: "theirs" }]);
    expect((await store.threads.get(scope, "shared"))?.subject).toBe("u1");
    expect((await store.threads.get(other, "shared"))?.subject).toBe("u2");
  });
});

describe("InMemorySavedVendoStore", () => {
  const draft = {
    name: "Late-night spend",
    pinned: false,
    uiTree: { kind: "component", id: "n1", name: "Text", props: {} } as never,
    query: { toolName: "get_transactions", input: { limit: 40 } },
    originatingPrompt: "show my late-night spending",
  };

  it("saves with store-owned identity and scopes reads/deletes", async () => {
    const store = createInMemoryStore({ now });
    const saved = await store.vendos.save(scope, draft);
    expect(saved.id).toBeTruthy();
    expect(saved.createdAt).toBe(now());
    expect(await store.vendos.get(scope, saved.id)).toEqual(saved);
    expect(await store.vendos.get(other, saved.id)).toBeUndefined();
    await store.vendos.delete(other, saved.id); // no-op outside scope
    expect(await store.vendos.list(scope)).toHaveLength(1);
    await store.vendos.delete(scope, saved.id);
    expect(await store.vendos.list(scope)).toHaveLength(0);
  });
});

describe("InMemoryRemixStore", () => {
  it("pins with upsert semantics: one record per (principal, anchorId), createdAt survives re-pins", async () => {
    let tick = 0;
    const ticking = () => `2026-07-04T00:00:0${tick++}.000Z`;
    const store = createInMemoryStore({ now: ticking });
    const first = await store.remixes.pin(scope, "invoices-widget", {
      uiTree: { kind: "component", id: "n1", name: "Text", props: {} } as never,
      originatingPrompt: "add a days-late column",
      components: { InvoiceRow: "v1" },
    });
    expect(first.anchorId).toBe("invoices-widget");
    expect(first.createdAt).toBe("2026-07-04T00:00:00.000Z");

    const second = await store.remixes.pin(scope, "invoices-widget", {
      uiTree: { kind: "component", id: "n2", name: "Text", props: {} } as never,
      originatingPrompt: "also sort by it",
    });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect((await store.remixes.get(scope, "invoices-widget"))?.uiTree.id).toBe("n2");
  });

  it("scopes reads and unpins per principal", async () => {
    const store = createInMemoryStore({ now });
    await store.remixes.pin(scope, "a1", {
      uiTree: { kind: "component", id: "n1", name: "Text", props: {} } as never,
      originatingPrompt: "p",
    });
    expect(await store.remixes.get(other, "a1")).toBeUndefined();
    await store.remixes.unpin(other, "a1");
    expect(await store.remixes.get(scope, "a1")).toBeDefined();
    await store.remixes.unpin(scope, "a1");
    expect(await store.remixes.get(scope, "a1")).toBeUndefined();
  });

  it("is isolated from caller mutation on both sides of the boundary", async () => {
    const store = createInMemoryStore({ now });
    const draft = {
      uiTree: { kind: "component", id: "n1", name: "Text", props: {} } as never,
      originatingPrompt: "p",
    };
    const pinned = await store.remixes.pin(scope, "a1", draft);
    (draft.uiTree as { id: string }).id = "corrupted-by-draft";
    (pinned.uiTree as { id: string }).id = "corrupted-by-return";
    expect((await store.remixes.get(scope, "a1"))?.uiTree.id).toBe("n1");
  });
});

describe("InMemoryAuditLog", () => {
  it("appends and exposes events for tests (append-only)", async () => {
    const store = createInMemoryStore({ now });
    await store.audit.append({
      at: now(),
      principal: scope,
      kind: "approval",
      toolCallId: "call-1",
      decision: "approved",
    });
    expect(store.audit.events).toHaveLength(1);
    expect(store.audit.events[0]?.kind).toBe("approval");
  });

  const seeded = async () => {
    const store = createInMemoryStore({ now });
    // Deliberately appended out of chronological order: query must sort by
    // `at` descending, not rely on insertion order.
    await store.audit.append({
      at: "2026-07-02T00:00:02Z",
      principal: scope,
      kind: "grant_revoked",
      grantId: "g1",
      tool: "send_email",
    });
    await store.audit.append({
      at: "2026-07-02T00:00:01Z",
      principal: scope,
      kind: "grant_created",
      grantId: "g1",
      tool: "send_email",
      scopePreview: "any input",
    });
    await store.audit.append({
      at: "2026-07-02T00:00:03Z",
      principal: scope,
      kind: "approval",
      toolCallId: "call-1",
      decision: "approved",
    });
    await store.audit.append({
      at: "2026-07-02T00:00:04Z",
      principal: other,
      kind: "approval",
      toolCallId: "call-2",
      decision: "denied",
    });
    return store;
  };

  it("query orders by `at` descending regardless of insertion order", async () => {
    const store = await seeded();
    const rows = await store.audit.query(scope);
    expect(rows.map((e) => e.at)).toEqual([
      "2026-07-02T00:00:03Z",
      "2026-07-02T00:00:02Z",
      "2026-07-02T00:00:01Z",
    ]);
  });

  it("query isolates by principal scope (different subject sees nothing)", async () => {
    const store = await seeded();
    const rows = await store.audit.query({ tenantId: "t1", subject: "nobody" });
    expect(rows).toHaveLength(0);
  });

  it("query filters by kinds; an empty kinds array means no kind filter", async () => {
    const store = await seeded();
    const grants = await store.audit.query(scope, {
      kinds: ["grant_created", "grant_revoked"],
    });
    expect(grants.map((e) => e.kind)).toEqual(["grant_revoked", "grant_created"]);
    expect(await store.audit.query(scope, { kinds: [] })).toHaveLength(3);
  });

  it("query's since boundary is inclusive (>=)", async () => {
    const store = await seeded();
    const rows = await store.audit.query(scope, { since: "2026-07-02T00:00:02Z" });
    expect(rows.map((e) => e.at)).toEqual(["2026-07-02T00:00:03Z", "2026-07-02T00:00:02Z"]);
  });

  it("query applies limit AFTER newest-first ordering", async () => {
    const store = await seeded();
    const rows = await store.audit.query(scope, { limit: 2 });
    expect(rows.map((e) => e.at)).toEqual(["2026-07-02T00:00:03Z", "2026-07-02T00:00:02Z"]);
  });
});

describe("Principal scope integrity", () => {
  // Delimiter-collision regression (PR #22 review): these two scopes
  // concatenate to the same "a::b::c" under a naive string key.
  const left: Principal = { tenantId: "a", subject: "b::c" };
  const right: Principal = { tenantId: "a::b", subject: "c" };

  it("scopes whose tenant/subject concatenations match stay isolated", async () => {
    const store = createInMemoryStore({ now });
    const thread = await store.threads.create(left);
    expect(await store.threads.get(right, thread.id)).toBeUndefined();
    expect(await store.threads.list(right)).toHaveLength(0);

    const saved = await store.vendos.save(left, {
      name: "n",
      pinned: false,
      uiTree: { kind: "component", id: "n1", name: "Text", props: {} } as never,
      query: { toolName: "t", input: {} },
      originatingPrompt: "p",
    });
    expect(await store.vendos.get(right, saved.id)).toBeUndefined();
    expect(await store.vendos.list(right)).toHaveLength(0);
  });
});

describe("isolation from caller mutation (PR #22 review)", () => {
  it("thread history is isolated from caller-owned and returned message objects", async () => {
    const store = createInMemoryStore({ now });
    const thread = await store.threads.create(scope);
    const message = { id: "m1", role: "user", parts: [] } as never;
    await store.threads.appendMessages(scope, thread.id, [message]);

    (message as { id: string }).id = "mutated-input";
    const readBack = await store.threads.getMessages(scope, thread.id);
    expect(readBack[0]?.id).toBe("m1");

    (readBack[0] as { id: string }).id = "mutated-output";
    expect((await store.threads.getMessages(scope, thread.id))[0]?.id).toBe("m1");
  });

  it("saved vendos are isolated from draft and returned-record mutation", async () => {
    const store = createInMemoryStore({ now });
    const draft = {
      name: "n",
      pinned: false,
      uiTree: { kind: "component", id: "n1", name: "Text", props: {} } as never,
      query: { toolName: "t", input: { limit: 40 } },
      originatingPrompt: "p",
    };
    const saved = await store.vendos.save(scope, draft);

    (draft.uiTree as { id: string }).id = "corrupted-by-draft";
    (saved.query.input as { limit: number }).limit = 999;
    const got = await store.vendos.get(scope, saved.id);
    expect((got?.uiTree as { id: string }).id).toBe("n1");
    expect((got?.query.input as { limit: number }).limit).toBe(40);
  });

  it("audit log is append-only: neither the input event, the returned array, nor its elements are live references", async () => {
    const store = createInMemoryStore({ now });
    const event = {
      at: now(),
      principal: scope,
      kind: "approval",
      toolCallId: "call-1",
      decision: "approved",
    } as const;
    await store.audit.append({ ...event });

    // Mutating the returned array or its elements must not touch the log.
    store.audit.events.splice(0);
    expect(store.audit.events).toHaveLength(1);
    const [first] = store.audit.events;
    (first as { decision: string }).decision = "denied";
    expect(store.audit.events[0]).toMatchObject({ decision: "approved" });
  });
});

describe("createInMemoryStore", () => {
  it("aggregates all four frozen sub-stores", async () => {
    const store = createInMemoryStore({ now });
    const record = await store.automations.save(scope, {
      name: "snitch",
      status: "enabled",
      // The smallest spec automationSpecSchema accepts (host_event + one step).
      spec: {
        dslVersion: 1,
        name: "snitch",
        description: "post to #general on late-night delivery",
        prompt: "snitch on me",
        trigger: { type: "host_event", event: "transaction.created" },
        execution: {
          mode: "steps",
          steps: [
            {
              id: "snitch",
              type: "tool",
              tool: "SLACK_SEND_MESSAGE",
              input: { channel: "#general", text: "hi" },
            },
          ],
        },
      },
    });
    expect(record.id).toBeTruthy();
    expect(record.createdAt).toBe(now());
    expect(await store.automations.list(other)).toHaveLength(0);
  });
});

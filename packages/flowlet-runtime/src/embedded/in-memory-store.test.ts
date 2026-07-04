import { describe, expect, it } from "vitest";
import type { Principal } from "@flowlet/core";
import { createInMemoryStore } from "./in-memory-store";

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
});

describe("InMemorySavedFlowletStore", () => {
  const draft = {
    name: "Late-night spend",
    pinned: false,
    uiTree: { kind: "component", id: "n1", name: "Text", props: {} } as never,
    query: { toolName: "get_transactions", input: { limit: 40 } },
    originatingPrompt: "show my late-night spending",
  };

  it("saves with store-owned identity and scopes reads/deletes", async () => {
    const store = createInMemoryStore({ now });
    const saved = await store.flowlets.save(scope, draft);
    expect(saved.id).toBeTruthy();
    expect(saved.createdAt).toBe(now());
    expect(await store.flowlets.get(scope, saved.id)).toEqual(saved);
    expect(await store.flowlets.get(other, saved.id)).toBeUndefined();
    await store.flowlets.delete(other, saved.id); // no-op outside scope
    expect(await store.flowlets.list(scope)).toHaveLength(1);
    await store.flowlets.delete(scope, saved.id);
    expect(await store.flowlets.list(scope)).toHaveLength(0);
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

    const saved = await store.flowlets.save(left, {
      name: "n",
      pinned: false,
      uiTree: { kind: "component", id: "n1", name: "Text", props: {} } as never,
      query: { toolName: "t", input: {} },
      originatingPrompt: "p",
    });
    expect(await store.flowlets.get(right, saved.id)).toBeUndefined();
    expect(await store.flowlets.list(right)).toHaveLength(0);
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

  it("saved flowlets are isolated from draft and returned-record mutation", async () => {
    const store = createInMemoryStore({ now });
    const draft = {
      name: "n",
      pinned: false,
      uiTree: { kind: "component", id: "n1", name: "Text", props: {} } as never,
      query: { toolName: "t", input: { limit: 40 } },
      originatingPrompt: "p",
    };
    const saved = await store.flowlets.save(scope, draft);

    (draft.uiTree as { id: string }).id = "corrupted-by-draft";
    (saved.query.input as { limit: number }).limit = 999;
    const got = await store.flowlets.get(scope, saved.id);
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

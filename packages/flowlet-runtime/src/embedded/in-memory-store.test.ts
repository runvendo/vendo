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

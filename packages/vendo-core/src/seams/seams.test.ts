import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "./credential-broker";
import type { Executor } from "./executor";
import type { Principal } from "./principal";
import type { Scheduler } from "./scheduler";
import type { Channels } from "./channels";
import type {
  Store,
  ThreadStore,
  SavedVendoStore,
  AutomationStore,
  AuditLog,
  RemixStore,
  RemixRecord,
} from "./store";

const principal: Principal = { tenantId: "t1", subject: "u1" };

// Minimal in-memory implementations: the embedded/CI guarantee in miniature.
// If these can't be written without a database or HTTP server, the seam is wrong.
function makeStore(): Store {
  const threads: ThreadStore = {
    create: async (scope, init) => ({
      id: "th1",
      tenantId: scope.tenantId,
      subject: scope.subject,
      title: init?.title,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-01T00:00:00Z",
    }),
    get: async () => undefined,
    list: async () => [],
    appendMessages: async () => {},
    getMessages: async () => [],
    upsertMessages: async () => {},
  };
  const vendos: SavedVendoStore = {
    save: async (_scope, f) => ({
      ...f,
      id: "f1",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-01T00:00:00Z",
    }),
    get: async () => undefined,
    list: async () => [],
    delete: async () => {},
  };
  const automations: AutomationStore = {
    save: async (_scope, a) => ({
      ...a,
      id: "a1",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-01T00:00:00Z",
    }),
    get: async () => undefined,
    list: async () => [],
    recordRun: async () => {},
    listRuns: async () => [],
  };
  const audit: AuditLog = { append: async () => {}, query: async () => [] };
  const remixPins = new Map<string, RemixRecord>();
  const remixes: RemixStore = {
    pin: async (scope, anchorId, record) => {
      const key = `${scope.tenantId}:${scope.subject}:${anchorId}`;
      const existing = remixPins.get(key);
      const pinned: RemixRecord = {
        ...record,
        anchorId,
        createdAt: existing?.createdAt ?? "2026-07-04T00:00:00Z",
        updatedAt: "2026-07-04T00:00:01Z",
      };
      remixPins.set(key, pinned);
      return pinned;
    },
    get: async (scope, anchorId) => remixPins.get(`${scope.tenantId}:${scope.subject}:${anchorId}`),
    unpin: async (scope, anchorId) => {
      remixPins.delete(`${scope.tenantId}:${scope.subject}:${anchorId}`);
    },
  };
  return { threads, vendos, automations, audit, remixes };
}

describe("seam interfaces are implementable in-memory", () => {
  it("Store", async () => {
    const store = makeStore();
    const t = await store.threads.create(principal, { title: "hi" });
    expect(t.tenantId).toBe("t1");
    // The store owns identity AND timestamps — callers never supply either.
    const f = await store.vendos.save(principal, {
      name: "My invoices",
      pinned: false,
      uiTree: { id: "n1", kind: "generated", payload: {} },
      query: { toolName: "listInvoices", input: {} },
      originatingPrompt: "show my invoices",
    });
    expect(f.id).toBe("f1");
    expect(f.createdAt).toBeTruthy();
  });

  it("CredentialBroker", async () => {
    const broker: CredentialBroker = {
      authenticate: async () => principal,
      acquireGrant: async (req) => ({
        token: "grant",
        expiresAt: "2026-07-01T00:05:00Z",
        scopes: req.scopes,
      }),
    };
    expect((await broker.authenticate("host-session")).subject).toBe("u1");
    expect(
      (await broker.acquireGrant({ principal, automationId: "a1", scopes: ["invoices:read"] }))
        .scopes,
    ).toEqual(["invoices:read"]);
  });

  it("Executor", async () => {
    const executor: Executor = {
      execute: async (call) => ({ ok: true, result: { echoed: call.input } }),
    };
    const out = await executor.execute(
      { toolCallId: "c1", toolName: "listInvoices", input: { limit: 1 } },
      { principal },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result).toEqual({ echoed: { limit: 1 } });
  });

  it("Scheduler", async () => {
    const fired: Array<{ automationId: string; subject: string }> = [];
    let handler:
      | ((f: { automationId: string; principal: Principal; firedAt: string }) => Promise<void>)
      | undefined;
    const scheduler: Scheduler = {
      schedule: async (id, _trigger, scope) => {
        await handler?.({ automationId: id, principal: scope, firedAt: "2026-07-01T00:00:00Z" });
      },
      cancel: async () => {},
      onFire: (h) => {
        handler = h;
      },
    };
    scheduler.onFire(async (f) => {
      fired.push({ automationId: f.automationId, subject: f.principal.subject });
    });
    await scheduler.schedule("a1", { kind: "cron", expression: "0 9 * * *" }, principal);
    expect(fired).toEqual([{ automationId: "a1", subject: "u1" }]);
  });

  it("Channels", async () => {
    const sent: string[] = [];
    const channels: Channels = {
      deliver: async (msg) => {
        sent.push(msg.channel);
      },
    };
    await channels.deliver({ channel: "in-app", principal, text: "done" });
    expect(sent).toEqual(["in-app"]);
  });

  it("RemixStore pins one record per (principal, anchorId) with upsert semantics", async () => {
    const store = makeStore();
    const first = await store.remixes.pin(principal, "invoices-widget", {
      uiTree: { id: "n1", kind: "generated", payload: {} },
      originatingPrompt: "add a days-late column",
      components: { InvoiceRow: "v1" },
    });
    // The store owns the anchor stamp and both timestamps.
    expect(first.anchorId).toBe("invoices-widget");
    expect(first.createdAt).toBeTruthy();
    expect(first.components).toEqual({ InvoiceRow: "v1" });

    // Upsert: pinning again replaces, preserving createdAt.
    const second = await store.remixes.pin(principal, "invoices-widget", {
      uiTree: { id: "n2", kind: "generated", payload: {} },
      originatingPrompt: "also sort by it",
    });
    expect(second.createdAt).toBe(first.createdAt);
    expect((await store.remixes.get(principal, "invoices-widget"))?.uiTree.id).toBe("n2");

    // Principal isolation: another subject sees nothing.
    const other = { tenantId: "t1", subject: "u2" };
    expect(await store.remixes.get(other, "invoices-widget")).toBeUndefined();

    // Unpin restores the default.
    await store.remixes.unpin(principal, "invoices-widget");
    expect(await store.remixes.get(principal, "invoices-widget")).toBeUndefined();
  });

  it("Channels carries the optional structured automation delivery", async () => {
    const deliveries: unknown[] = [];
    const channels: Channels = {
      deliver: async (msg) => {
        deliveries.push(msg.automation);
      },
    };
    await channels.deliver({
      channel: "in-app",
      principal,
      text: "Morning chase ran: 2 sent, 1 draft needs review.",
      automation: { kind: "completed", runId: "r1", summary: "2 sent, 1 draft needs review" },
    });
    await channels.deliver({
      channel: "in-app",
      principal,
      text: "Approval needed: email Henderson.",
      automation: {
        kind: "approval-required",
        runId: "r2",
        stepId: "s3",
        summary: "email Henderson",
      },
    });
    expect(deliveries).toEqual([
      { kind: "completed", runId: "r1", summary: "2 sent, 1 draft needs review" },
      { kind: "approval-required", runId: "r2", stepId: "s3", summary: "email Henderson" },
    ]);
  });
});

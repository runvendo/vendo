import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "./credential-broker.js";
import type { Executor } from "./executor.js";
import type { Principal } from "./principal.js";
import type { Scheduler } from "./scheduler.js";
import type { Channels } from "./channels.js";
import type {
  Store,
  ThreadStore,
  AutomationStore,
  AuditLog,
} from "./store.js";

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
  return { threads, automations, audit };
}

describe("seam interfaces are implementable in-memory", () => {
  it("Store", async () => {
    const store = makeStore();
    const t = await store.threads.create(principal, { title: "hi" });
    expect(t.tenantId).toBe("t1");
    const automation = await store.automations.save(principal, {
      name: "Morning report",
      status: "enabled",
      spec: {},
    });
    expect(automation.id).toBe("a1");
    expect(automation.createdAt).toBeTruthy();
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

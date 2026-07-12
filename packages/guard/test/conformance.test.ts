import { describe, expect, it } from "vitest";
import type { AuditEvent, RunContext, ToolCall, ToolDescriptor } from "@vendoai/core";
import { guardConformance, memoryStoreAdapter, runConformance } from "@vendoai/core/conformance";
import { createGuard } from "../src/index.js";
import { createPGliteStore } from "./fixtures/pglite-store.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user-conformance" },
  venue: "chat",
  presence: "present",
  sessionId: "sess-conformance",
};

const criticalDescriptor: ToolDescriptor = {
  name: "host_account_close",
  description: "Close the account permanently.",
  inputSchema: { type: "object", properties: { accountId: { type: "string" } } },
  risk: "destructive",
  critical: true,
};

const criticalCall: ToolCall = {
  id: "call-conformance-critical",
  tool: "host_account_close",
  args: { accountId: "acct_1" },
};

const readDescriptor: ToolDescriptor = {
  name: "host_invoices_list",
  description: "List invoices.",
  inputSchema: { type: "object", properties: {} },
  risk: "read",
};

const readCall: ToolCall = {
  id: "call-conformance-read",
  tool: "host_invoices_list",
  args: {},
};

const sampleAuditEvent: AuditEvent = {
  id: "aud_conformance-sample",
  at: new Date().toISOString(),
  kind: "tool-call",
  principal: ctx.principal,
  venue: "chat",
  presence: "present",
  tool: "host_invoices_list",
  outcome: "ok",
  decidedBy: "default",
};

describe("core Guard conformance kit", () => {
  it("passes against the memory store reference double", async () => {
    const report = await runConformance(
      guardConformance({
        makeGuard: async () => createGuard({ store: memoryStoreAdapter() }),
        ctx,
        criticalDescriptor,
        criticalCall,
        readDescriptor,
        readCall,
        sampleAuditEvent,
      }),
    );
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.passed).toBeGreaterThanOrEqual(5);
  });

  it("passes against the real-SQL PGlite store fixture", async () => {
    const store = await createPGliteStore();
    try {
      const report = await runConformance(
        guardConformance({
          makeGuard: async () => createGuard({ store }),
          ctx,
          criticalDescriptor,
          criticalCall,
          readDescriptor,
          readCall,
          sampleAuditEvent,
        }),
      );
      expect(report.failures).toEqual([]);
      expect(report.ok).toBe(true);
    } finally {
      await store.close();
    }
  });
});

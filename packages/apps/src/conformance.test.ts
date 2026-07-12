import { describe, it } from "vitest";
import {
  guardConformance,
  storeAdapterConformance,
  type ConformanceSuite,
} from "@vendoai/core/conformance";
import type { RunContext, ToolCall, ToolDescriptor } from "@vendoai/core";
import { guardFixture } from "./testing/guard-fixture.js";
import { memoryStore } from "./testing/memory-store.js";

/** Mount a core conformance suite as vitest cases. */
const mount = (suite: ConformanceSuite): void => {
  describe(`core conformance: ${suite.seam}`, () => {
    for (const conformanceCase of suite.cases) {
      it(conformanceCase.name, conformanceCase.run);
    }
  });
};

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_conformance" },
  venue: "app",
  presence: "present",
  sessionId: "sess_conformance",
};

const criticalDescriptor: ToolDescriptor = {
  name: "host_payments_send",
  description: "conformance: critical tool",
  inputSchema: { type: "object" },
  risk: "destructive",
  critical: true,
};
const readDescriptor: ToolDescriptor = {
  name: "host_invoices_list",
  description: "conformance: read tool",
  inputSchema: { type: "object" },
  risk: "read",
};
const criticalCall: ToolCall = { id: "call_conf_1", tool: criticalDescriptor.name, args: {} };
const readCall: ToolCall = { id: "call_conf_2", tool: readDescriptor.name, args: {} };

// The e2e suite's fixtures must themselves be conformant, or the suite proves nothing.
mount(storeAdapterConformance({
  makeAdapter: async () => ({ adapter: memoryStore() }),
}));

mount(guardConformance({
  makeGuard: async () => guardFixture(),
  ctx,
  criticalDescriptor,
  criticalCall,
  readDescriptor,
  readCall,
  sampleAuditEvent: {
    id: "aud_conformance_1",
    at: new Date().toISOString(),
    kind: "tool-call",
    principal: ctx.principal,
    venue: ctx.venue,
    presence: ctx.presence,
    tool: readDescriptor.name,
    outcome: "ok",
  },
}));

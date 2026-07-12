import { describe, expect, it } from "vitest";
import { runConformance, toolRegistryConformance } from "@vendoai/core/conformance";
import type { RunContext, ToolDescriptor } from "@vendoai/core";
import type { Connector } from "../connectors/connector.js";
import type { ExtractedTool } from "../formats.js";
import { createActions } from "./registry.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_conf" },
  venue: "chat",
  presence: "present",
  sessionId: "session_conf",
};

const hostTools: ExtractedTool[] = [
  {
    name: "host_invoices_list",
    description: "List invoices",
    inputSchema: { type: "object", properties: {} },
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
  },
  {
    name: "host_invoices_delete",
    description: "Delete an invoice",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    risk: "destructive",
    critical: true,
    binding: { kind: "route", method: "DELETE", path: "/api/invoices/{id}", argsIn: "query" },
  },
];

const connectorDescriptors: ToolDescriptor[] = [
  { name: "gmail_send", description: "Send an email", inputSchema: { type: "object" }, risk: "write" },
];

const connector: Connector = {
  name: "gmail",
  descriptors: async () => connectorDescriptors,
  execute: async () => ({ status: "ok", output: { sent: true } }),
};

describe("core ToolRegistry conformance kit", () => {
  it("passes for a host-tools + connector ActionsRegistry", async () => {
    const suite = toolRegistryConformance({
      makeRegistry: async () => createActions({ connectors: [connector], tools: hostTools }),
      ctx,
      // Safe call: the connector-backed tool executes without any HTTP server.
      safeCall: { id: "call_conf_1", tool: "gmail_send", args: {} },
    });
    const report = await runConformance(suite);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(suite.cases.length);
  });
});

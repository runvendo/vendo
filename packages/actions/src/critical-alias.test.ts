import { describe, expect, it } from "vitest";
import {
  VENDO_JUDGMENTS_FORMAT,
  VENDO_OVERRIDES_FORMAT,
  VENDO_TOOLS_FORMAT,
  judgmentsFileSchema,
  overridesFileSchema,
  toolsFileSchema,
} from "./formats.js";

/**
 * Risk-grading redesign D5, AC5 — `confirmEach` was called `critical`. Host
 * files written before the rename keep loading, indefinitely: read old, write
 * new. These fixtures are byte-for-byte what a pre-rename install has on disk.
 */

const routeBinding = { kind: "route", method: "POST", path: "/api/invoices/{id}/send", argsIn: "body" } as const;

describe("host files spelled `critical:` load unchanged (D5, AC5)", () => {
  it("reads a legacy .vendo/overrides.json per-tool override", () => {
    const parsed = overridesFileSchema.parse({
      format: VENDO_OVERRIDES_FORMAT,
      tools: { host_invoices_send: { risk: "write", critical: true } },
    });
    expect(parsed.tools.host_invoices_send).toEqual({ risk: "write", confirmEach: true });
  });

  it("reads a legacy overrides compound", () => {
    const parsed = overridesFileSchema.parse({
      format: VENDO_OVERRIDES_FORMAT,
      tools: {},
      compounds: [{
        name: "host_send_all",
        description: "Send every draft invoice",
        inputSchema: { type: "object" },
        risk: "write",
        critical: true,
        binding: { kind: "compound", steps: [{ id: "s1", tool: "host_invoices_send" }] },
      }],
    });
    expect(parsed.compounds?.[0]).toMatchObject({ confirmEach: true });
    expect(parsed.compounds?.[0]).not.toHaveProperty("critical");
  });

  it("reads a legacy .vendo/judgments.json field AND a legacy pending loosening", () => {
    const parsed = judgmentsFileSchema.parse({
      format: VENDO_JUDGMENTS_FORMAT,
      tools: {
        host_invoices_send: {
          binding: "route:POST /api/invoices/{id}/send",
          fields: { risk: "write", critical: true },
          evidence: "await mailer.send(invoice)",
          pending: [{ field: "critical", value: false, evidence: "the send is queued, not delivered" }],
        },
      },
    });
    expect(parsed.tools.host_invoices_send?.fields).toEqual({ risk: "write", confirmEach: true });
    expect(parsed.tools.host_invoices_send?.pending?.[0]?.field).toBe("confirmEach");
  });

  it("reads a legacy .vendo/tools.json entry that carries the flag", () => {
    const parsed = toolsFileSchema.parse({
      format: VENDO_TOOLS_FORMAT,
      tools: [{
        name: "host_invoices_send",
        description: "Send invoice",
        inputSchema: { type: "object" },
        risk: "write",
        critical: true,
        binding: routeBinding,
      }],
    });
    expect(parsed.tools[0]).toMatchObject({ confirmEach: true });
    expect(parsed.tools[0]).not.toHaveProperty("critical");
  });

  it("lets an explicit confirmEach win when a file somehow carries both", () => {
    const parsed = overridesFileSchema.parse({
      format: VENDO_OVERRIDES_FORMAT,
      tools: { host_invoices_send: { critical: false, confirmEach: true } },
    });
    expect(parsed.tools.host_invoices_send?.confirmEach).toBe(true);
  });

  it("still fails loudly on a real typo — the alias is one name, not a passthrough", () => {
    expect(overridesFileSchema.safeParse({
      format: VENDO_OVERRIDES_FORMAT,
      tools: { host_invoices_send: { criticl: true } },
    }).success).toBe(false);
  });
});

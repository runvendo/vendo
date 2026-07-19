import type { AuditEvent } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  describeActivity,
  formatAuditTime,
  formatRelativeAuditTime,
  kindGlyph,
  outcomeLabel,
} from "../../src/chrome/activity-semantics.js";

describe("formatRelativeAuditTime", () => {
  const now = new Date("2026-07-18T10:00:00.000Z");
  it("maps elapsed time to human buckets, deterministically from `now`", () => {
    expect(formatRelativeAuditTime("2026-07-18T09:59:40.000Z", now)).toBe("just now");
    expect(formatRelativeAuditTime("2026-07-18T09:06:00.000Z", now)).toBe("54m ago");
    expect(formatRelativeAuditTime("2026-07-18T08:00:00.000Z", now)).toBe("2h ago");
    expect(formatRelativeAuditTime("2026-07-17T08:00:00.000Z", now)).toBe("yesterday");
  });
  it("falls back to the absolute string beyond 48h, for the future, and for junk", () => {
    expect(formatRelativeAuditTime("2026-07-11T12:00:00.000Z", now)).toBe("Jul 11, 2026, 12:00 PM");
    expect(formatRelativeAuditTime("2026-07-19T10:00:00.000Z", now)).toBe("Jul 19, 2026, 10:00 AM");
    expect(formatRelativeAuditTime("not-a-date", now)).toBe("not-a-date");
  });
});

describe("kindGlyph", () => {
  it("maps every audit kind to a ledger glyph", () => {
    expect(kindGlyph("tool-call")).toBe("wrench");
    expect(kindGlyph("run")).toBe("zap");
    expect(kindGlyph("approval")).toBe("shield");
    expect(kindGlyph("policy-decision")).toBe("shield");
    expect(kindGlyph("app-lifecycle")).toBe("box");
    expect(kindGlyph("share")).toBe("box");
    expect(kindGlyph("door-auth")).toBe("wrench");
    expect(kindGlyph("principal")).toBe("wrench");
  });
});
function event(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    id: "aud_1",
    at: "2026-07-11T12:00:00.000Z",
    kind: "tool-call",
    principal: { kind: "user", subject: "user_1" },
    venue: "chat",
    presence: "present",
    ...overrides,
  };
}

describe("formatAuditTime", () => {
  it("renders an ISO instant as a human, UTC-stable absolute timestamp", () => {
    // UTC-pinned so the string is identical on a laptop and in CI.
    expect(formatAuditTime("2026-07-11T12:00:00.000Z")).toBe("Jul 11, 2026, 12:00 PM");
    expect(formatAuditTime("2026-01-02T00:05:00.000Z")).toBe("Jan 2, 2026, 12:05 AM");
    expect(formatAuditTime("2026-12-31T23:59:00.000Z")).toBe("Dec 31, 2026, 11:59 PM");
    expect(formatAuditTime("2026-07-11T13:07:00.000Z")).toBe("Jul 11, 2026, 1:07 PM");
  });

  it("returns the raw value unchanged when it is not a parseable instant", () => {
    expect(formatAuditTime("not-a-date")).toBe("not-a-date");
  });
});

describe("outcomeLabel", () => {
  it("maps every wire outcome to a human label and a tone", () => {
    expect(outcomeLabel("ok")).toEqual({ label: "Succeeded", tone: "ok" });
    expect(outcomeLabel("error")).toEqual({ label: "Failed", tone: "error" });
    expect(outcomeLabel("pending-approval")).toEqual({ label: "Awaiting approval", tone: "pending" });
    expect(outcomeLabel("blocked")).toEqual({ label: "Blocked", tone: "blocked" });
    expect(outcomeLabel("connect-required")).toEqual({ label: "Connect required", tone: "connect" });
  });

  it("treats a missing outcome as still running", () => {
    expect(outcomeLabel(undefined)).toEqual({ label: "Running", tone: "running" });
  });
});

describe("describeActivity", () => {
  it("humanizes a tool call into a concrete, readable action", () => {
    const described = describeActivity(event({ kind: "tool-call", tool: "host_invoices_list" }));
    expect(described.kindLabel).toBe("Tool");
    expect(described.action).toBe("Invoices list");
  });

  it("prefers host-supplied tool metadata over the slug fallback", () => {
    const described = describeActivity(
      event({ kind: "tool-call", tool: "host_invoices_list" }),
      { host_invoices_list: { label: "List invoices" } },
    );
    expect(described.action).toBe("List invoices");
  });

  it("names an approval after the tool it gates", () => {
    const described = describeActivity(event({ kind: "approval", tool: "host_delete_invoice" }));
    expect(described.kindLabel).toBe("Approval");
    expect(described.action).toBe("Approval: Delete invoice");
  });

  it("gives every other audit kind a concrete phrase", () => {
    expect(describeActivity(event({ kind: "door-auth", tool: undefined })).action).toBe("Account connected");
    expect(describeActivity(event({ kind: "run", tool: undefined })).action).toBe("Automation run");
    expect(describeActivity(event({ kind: "policy-decision", tool: undefined })).action).toBe("Policy decision");
    expect(describeActivity(event({ kind: "app-lifecycle", tool: undefined })).action).toBe("App updated");
    expect(describeActivity(event({ kind: "share", tool: undefined })).action).toBe("App shared");
    expect(describeActivity(event({ kind: "principal", tool: undefined })).action).toBe("Identity updated");
  });

  it("falls back to a readable phrase for a tool call with no tool id", () => {
    expect(describeActivity(event({ kind: "tool-call", tool: undefined })).action).toBe("Tool call");
  });
});

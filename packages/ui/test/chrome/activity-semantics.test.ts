import type { AuditEvent } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  decidedByLabel,
  describeActivity,
  eventOutcomeLabel,
  formatAuditTime,
  formatRelativeAuditTime,
  kindGlyph,
  outcomeLabel,
} from "../../src/chrome/activity-semantics.js";
import { activityDetail } from "../../src/chrome/activity-ledger.js";

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

describe("eventOutcomeLabel", () => {
  it("reads a decided approval's resolution from detail — never 'Running' forever", () => {
    expect(eventOutcomeLabel({ kind: "approval", outcome: undefined, detail: { approved: true } }))
      .toEqual({ label: "Approved", tone: "ok" });
    expect(eventOutcomeLabel({ kind: "approval", outcome: undefined, detail: { approved: false } }))
      .toEqual({ label: "Denied", tone: "blocked" });
    expect(eventOutcomeLabel({ kind: "approval", outcome: undefined, detail: { grantRevoked: "grt_1" } }))
      .toEqual({ label: "Grant revoked", tone: "ok" });
  });

  it("keeps the pending ask and every wire outcome exactly as outcomeLabel maps them", () => {
    expect(eventOutcomeLabel({ kind: "approval", outcome: "pending-approval", detail: undefined }))
      .toEqual({ label: "Awaiting approval", tone: "pending" });
    expect(eventOutcomeLabel({ kind: "tool-call", outcome: "ok", detail: undefined }))
      .toEqual({ label: "Succeeded", tone: "ok" });
    // A genuinely in-flight event (no outcome, no decision detail) still runs.
    expect(eventOutcomeLabel({ kind: "tool-call", outcome: undefined, detail: undefined }))
      .toEqual({ label: "Running", tone: "running" });
    expect(eventOutcomeLabel({ kind: "approval", outcome: undefined, detail: undefined }))
      .toEqual({ label: "Running", tone: "running" });
  });

  it("D6 · a harness run row is written at turn END, so it never reads as in flight", () => {
    expect(eventOutcomeLabel({ kind: "run", outcome: undefined, detail: { harness: "vendo", usage: {} } }))
      .toEqual({ label: "Succeeded", tone: "ok" });
    expect(eventOutcomeLabel({
      kind: "run",
      outcome: undefined,
      detail: { harness: "claude-code", error: { message: "boom" } },
    })).toEqual({ label: "Failed", tone: "error" });
  });

  it("D6 · an automation-engine run row keeps its own older display, untouched", () => {
    // Those rows carry `status` in detail, not `harness`. What they should read
    // is a separate question and this fix deliberately does not answer it.
    expect(eventOutcomeLabel({ kind: "run", outcome: undefined, detail: { status: "ok" } }))
      .toEqual({ label: "Running", tone: "running" });
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
    // The fixture's venue is `chat`, so "Automation run" was this expectation
    // pinning the bug, not describing the product.
    expect(describeActivity(event({ kind: "run", tool: undefined })).action).toBe("Chat turn");
    expect(describeActivity(event({ kind: "policy-decision", tool: undefined })).action).toBe("Policy decision");
    expect(describeActivity(event({ kind: "app-lifecycle", tool: undefined })).action).toBe("App updated");
    expect(describeActivity(event({ kind: "share", tool: undefined })).action).toBe("App shared");
    expect(describeActivity(event({ kind: "principal", tool: undefined })).action).toBe("Identity updated");
  });

  it("falls back to a readable phrase for a tool call with no tool id", () => {
    expect(describeActivity(event({ kind: "tool-call", tool: undefined })).action).toBe("Tool call");
  });

  it("D6 · names a run after the DOOR it arrived through, never 'Automation' for all four", () => {
    // Measured: seven finished chat turns on a user's own activity rail, every
    // one of them reading "Automation run", while not one automation had run.
    for (const [venue, badge, action] of [
      ["chat", "Chat", "Chat turn"],
      ["app", "App", "App run"],
      ["automation", "Automation", "Automation run"],
      ["mcp", "Agent", "Connected agent run"],
    ] as const) {
      const described = describeActivity(event({ kind: "run", tool: undefined, venue }));
      expect(described.kindLabel).toBe(badge);
      expect(described.action).toBe(action);
    }
  });

  it("D6 · a hired specialist gets its own sentence, not the thread's", () => {
    const described = describeActivity(event({
      kind: "run",
      tool: undefined,
      detail: { harness: "claude-code", subagent: { purpose: "build the app" } },
    }));
    expect(described.action).toBe("Specialist hired");
  });
});

/** CR-2 — the ledger's detail line humanized the LABELS and let the VALUES
 *  through verbatim, so a person's own activity rail read
 *  "App id app_9a3f2b1c · Instruction add a chart". */
describe("activityDetail — the values are consumer copy too", () => {
  const preview = (tool: string, args: unknown) => activityDetail({ tool, inputPreview: `${tool} ${JSON.stringify(args)}` });

  it("drops an id-shaped value and keeps the words a person wrote", () => {
    expect(preview("vendo_apps_edit", { appId: "app_9a3f2b1c", instruction: "add a chart" }))
      .toBe("Instruction add a chart");
  });

  it("says nothing at all when every value is an id", () => {
    expect(preview("vendo_apps_open", { appId: "app_9a3f2b1c", threadId: "thr_18f0" })).toBeUndefined();
  });

  it("keeps ordinary values that merely contain an underscore", () => {
    expect(preview("host_invoices_list", { status: "past_due" })).toBe("Status past_due");
  });

  it("stays a SCANNABLE line — three fields at the 400-char value cap is 1.2 kB", () => {
    const detail = preview("host_invoices_list", {
      note: "x".repeat(600),
      other: "y".repeat(600),
      third: "z".repeat(600),
    });
    expect(detail).toBeDefined();
    expect(detail!.length).toBeLessThanOrEqual(121);
  });
});

describe("decidedByLabel", () => {
  it("says what actually happened: an older no is still standing", () => {
    // Raw, the ledger read "blocked by denied", which sounds like a fresh
    // refusal. It is the user's OWN no from earlier doing the blocking.
    expect(decidedByLabel("denied")).toBe("previously denied");
  });

  it("humanizes the other slugs a person would stumble over", () => {
    expect(decidedByLabel("confirmEach")).toBe("confirm-each");
    expect(decidedByLabel("default")).toBe("the default posture");
  });

  it("passes through the ones that already read as English", () => {
    for (const slug of ["grant", "rule", "judge", "breaker"]) {
      expect(decidedByLabel(slug)).toBe(slug);
    }
  });
});

describe("eventOutcomeLabel — taking a decision back", () => {
  it("names an approval revoke instead of leaving it Running forever", () => {
    expect(eventOutcomeLabel({
      kind: "approval",
      outcome: undefined,
      detail: { approvalRevoked: "apr_1", priorStatus: "denied" },
    })).toEqual({ label: "Decision taken back", tone: "ok" });
  });

  it("says a no that arrived mid-replay came too late — never a row still Running", () => {
    expect(eventOutcomeLabel({
      kind: "approval",
      outcome: undefined,
      detail: { supersedeTooLate: "apr_1" },
    })).toEqual({ label: "Ran before the no landed", tone: "error" });
  });
});

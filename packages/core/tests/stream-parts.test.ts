import { describe, expect, it } from "vitest";
import {
  toVendoWirePart,
  vendoApprovalPartSchema,
  vendoAutomationPartSchema,
  vendoGrantSetPartSchema,
  vendoBuildFailedPartSchema,
  vendoCitationsPartSchema,
  vendoStepLimitPartSchema,
  vendoConnectPartSchema,
  vendoViewPartSchema,
  vendoViewWirePartSchema,
} from "../src/stream-parts.js";

/** 01-core §16 — the custom data-parts the wire carries. */
describe("vendoViewPartSchema", () => {
  it("accepts a view part carrying an opaque (forward-version) payload", () => {
    expect(
      vendoViewPartSchema.safeParse({
        type: "data-vendo-view",
        appId: "app_1",
        payload: { formatVersion: "future-ui/v2", opaque: true },
      }).success,
    ).toBe(true);
  });

  it("rejects a wrong type literal or a missing appId", () => {
    expect(
      vendoViewPartSchema.safeParse({ type: "data-view", appId: "app_1", payload: { formatVersion: "x" } }).success,
    ).toBe(false);
    expect(
      vendoViewPartSchema.safeParse({ type: "data-vendo-view", payload: { formatVersion: "x" } }).success,
    ).toBe(false);
  });
});

describe("vendoApprovalPartSchema", () => {
  it("accepts a part with and without the optional approvalId", () => {
    expect(
      vendoApprovalPartSchema.safeParse({
        type: "data-vendo-approval",
        toolCallId: "call_1",
        risk: "destructive",
        approvalId: "apr_1",
      }).success,
    ).toBe(true);
    expect(
      vendoApprovalPartSchema.safeParse({ type: "data-vendo-approval", toolCallId: "call_1", risk: "read" }).success,
    ).toBe(true);
  });

  it("rejects a non-risk-label risk and a malformed approvalId", () => {
    // "critical" is a descriptor flag, not a RiskLabel.
    expect(
      vendoApprovalPartSchema.safeParse({ type: "data-vendo-approval", toolCallId: "call_1", risk: "critical" }).success,
    ).toBe(false);
    expect(
      vendoApprovalPartSchema.safeParse({
        type: "data-vendo-approval",
        toolCallId: "call_1",
        risk: "write",
        approvalId: "xyz_1",
      }).success,
    ).toBe(false);
  });
});

describe("vendoConnectPartSchema", () => {
  it("accepts a connect part naming the connector and toolkit for one tool call", () => {
    expect(
      vendoConnectPartSchema.safeParse({
        type: "data-vendo-connect",
        toolCallId: "call_1",
        connector: "composio",
        toolkit: "gmail",
        message: "Connect your gmail account to run gmail_SEND_EMAIL",
      }).success,
    ).toBe(true);
  });

  it("rejects a wrong type literal or a missing toolkit", () => {
    expect(
      vendoConnectPartSchema.safeParse({
        type: "data-vendo-approval",
        toolCallId: "call_1",
        connector: "composio",
        toolkit: "gmail",
        message: "x",
      }).success,
    ).toBe(false);
    expect(
      vendoConnectPartSchema.safeParse({
        type: "data-vendo-connect",
        toolCallId: "call_1",
        connector: "composio",
        message: "x",
      }).success,
    ).toBe(false);
  });
});

/** AGENT-10 (wave 5, additive): the nested ai-SDK envelope the wire and
 *  persisted UIMessages actually carry — `{ type, data: {...}, id? }`. */
describe("wire envelopes for §16 parts", () => {
  it("toVendoWirePart nests every flat field under data and carries the reconciliation id", () => {
    const flat = {
      type: "data-vendo-view" as const,
      appId: "app_1",
      payload: { formatVersion: "vendo-genui/v2", root: "r", nodes: [] },
    };
    expect(toVendoWirePart(flat, "vendo-view:app_1")).toEqual({
      type: "data-vendo-view",
      id: "vendo-view:app_1",
      data: { appId: "app_1", payload: flat.payload },
    });
    expect(toVendoWirePart(flat)).toEqual({
      type: "data-vendo-view",
      data: { appId: "app_1", payload: flat.payload },
    });
  });

  it("vendoViewWirePartSchema parses the nested shape and rejects the flat one", () => {
    const wire = {
      type: "data-vendo-view",
      id: "vendo-view:app_1",
      data: { appId: "app_1", payload: { formatVersion: "vendo-genui/v2" } },
    };
    expect(vendoViewWirePartSchema.safeParse(wire).success).toBe(true);
    expect(vendoViewWirePartSchema.safeParse({
      type: "data-vendo-view",
      appId: "app_1",
      payload: { formatVersion: "vendo-genui/v2" },
    }).success).toBe(false);
  });
});

/** AGENT-7 (wave 5, additive): visible step-cap exhaustion. */
describe("vendoStepLimitPartSchema", () => {
  it("accepts a step-limit notice with the cap and a renderable message", () => {
    expect(vendoStepLimitPartSchema.safeParse({
      type: "data-vendo-step-limit",
      limit: 20,
      message: "Stopped after 20 steps.",
    }).success).toBe(true);
  });

  it("rejects a wrong type literal or a non-integer limit", () => {
    expect(vendoStepLimitPartSchema.safeParse({
      type: "data-vendo-view",
      limit: 20,
      message: "x",
    }).success).toBe(false);
    expect(vendoStepLimitPartSchema.safeParse({
      type: "data-vendo-step-limit",
      limit: 1.5,
      message: "x",
    }).success).toBe(false);
  });
});

/** 0.4.4 cert defect B (additive): visible terminal build failure. */
describe("vendoBuildFailedPartSchema", () => {
  it("accepts a failed-build banner with the call id and a renderable reason", () => {
    expect(vendoBuildFailedPartSchema.safeParse({
      type: "data-vendo-build-failed",
      toolCallId: "call_1",
      reason: "app build failed: generation failed",
    }).success).toBe(true);
  });

  it("rejects a wrong type literal or an empty reason", () => {
    expect(vendoBuildFailedPartSchema.safeParse({
      type: "data-vendo-step-limit",
      toolCallId: "call_1",
      reason: "x",
    }).success).toBe(false);
    expect(vendoBuildFailedPartSchema.safeParse({
      type: "data-vendo-build-failed",
      toolCallId: "call_1",
      reason: "",
    }).success).toBe(false);
  });
});

/** 2026-07 demo feedback (additive): the in-thread automation card part. */
describe("vendoAutomationPartSchema", () => {
  it("accepts an automation card with a trigger and enabled state", () => {
    expect(vendoAutomationPartSchema.safeParse({
      type: "data-vendo-automation",
      appId: "app_auto",
      name: "Low balance alert",
      enabled: true,
      description: "Emails you when checking dips below $2,000.",
      trigger: {
        id: "main",
        on: { kind: "schedule", cron: "0 8 * * *" },
        run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
      },
    }).success).toBe(true);
  });

  it("trigger stays optional; a wrong type literal or empty name rejects", () => {
    expect(vendoAutomationPartSchema.safeParse({
      type: "data-vendo-automation",
      appId: "app_auto",
      name: "Weekly digest",
      enabled: false,
    }).success).toBe(true);
    expect(vendoAutomationPartSchema.safeParse({
      type: "data-vendo-view",
      appId: "app_auto",
      name: "Weekly digest",
      enabled: true,
    }).success).toBe(false);
    expect(vendoAutomationPartSchema.safeParse({
      type: "data-vendo-automation",
      appId: "app_auto",
      name: "",
      enabled: true,
    }).success).toBe(false);
  });

  /** The automation's terms ride the TRIGGER (`Trigger.rules`) — the document's
   *  own field, forwarded whole by every producer that already forwards a
   *  trigger — so this part has no second copy of them to disagree with.
   *
   *  A blank sentence must cost that sentence and nothing else. This part is
   *  `safeParse`d at the bridge before the thread ever sees it, so a `min(1)`
   *  on the array would have made one empty string from a sloppy author delete
   *  the entire automation card; the renderer is the one place that decides
   *  what is renderable (`@vendoai/ui`'s automation card trims, drops, clamps
   *  and caps). */
  it("carries the trigger's rule sentences, and one blank never fails the part", () => {
    const withRules = (rules: unknown) => vendoAutomationPartSchema.safeParse({
      type: "data-vendo-automation",
      appId: "app_auto",
      name: "PG&E autopay",
      enabled: true,
      trigger: {
        id: "main",
        on: { kind: "external", connector: "gmail", event: "new_bill_email" },
        run: { kind: "steps", steps: [{ id: "pay", tool: "host_transferMoney" }] },
        rules,
      },
    });
    const kept = withRules(["Caps at $200 a bill — anything higher asks you first", "  "]);
    expect(kept.success).toBe(true);
    expect(kept.data!.trigger!.rules).toEqual([
      "Caps at $200 a bill — anything higher asks you first",
      "  ",
    ]);
    expect(withRules([]).success).toBe(true);
    // A rule that is not a string at all is a broken producer, not a sloppy
    // author: the array's element type still holds the line.
    expect(withRules([{ text: "nope" }]).success).toBe(false);
  });
});

/** demo-live-readiness 2026-07 (additive): the grant-set consent card part. */
describe("vendoGrantSetPartSchema", () => {
  const permissions = [
    { approvalId: "apr_1", tool: "host_getSpendingInsights", description: "See category totals.", risk: "read" },
    { approvalId: "apr_2", tool: "host_listTransactions", risk: "read" },
  ];

  it("accepts a set of enumerated permissions keyed to a parked call", () => {
    expect(vendoGrantSetPartSchema.safeParse({
      type: "data-vendo-grant-set",
      toolCallId: "mds_grant_weekly_1",
      grantSetId: "gset_1",
      appId: "app_demo_weekly",
      name: "Weekly spending summary",
      permissions,
    }).success).toBe(true);
  });

  it("rejects an empty set, a missing grantSetId, and a wrong type literal", () => {
    expect(vendoGrantSetPartSchema.safeParse({
      type: "data-vendo-grant-set",
      toolCallId: "mds_grant_weekly_1",
      grantSetId: "gset_1",
      appId: "app_demo_weekly",
      name: "Weekly spending summary",
      permissions: [],
    }).success).toBe(false);
    expect(vendoGrantSetPartSchema.safeParse({
      type: "data-vendo-grant-set",
      toolCallId: "mds_grant_weekly_1",
      appId: "app_demo_weekly",
      name: "Weekly spending summary",
      permissions,
    }).success).toBe(false);
    expect(vendoGrantSetPartSchema.safeParse({
      type: "data-vendo-approval",
      toolCallId: "mds_grant_weekly_1",
      grantSetId: "gset_1",
      appId: "app_demo_weekly",
      name: "Weekly spending summary",
      permissions,
    }).success).toBe(false);
  });
});

/** Knowledge K1 (additive): the citation-chips part `vendo_knowledge_search`
    results ride to the UI. */
describe("vendoCitationsPartSchema", () => {
  it("accepts a grounded answer and round-trips through the wire envelope", () => {
    const part = {
      type: "data-vendo-citations",
      toolCallId: "call_k1",
      outcome: "answered",
      citations: [{
        docId: "doc-transfers",
        chunkId: "doc-transfers#0",
        title: "Wire transfer limits",
        source: "docs/transfers.md",
        kind: "docs",
        visibility: "public",
        snippet: "Maple caps outbound wire transfers at $25,000 per business day.",
      }],
    };
    const parsed = vendoCitationsPartSchema.safeParse(part);
    expect(parsed.success).toBe(true);
    const wire = toVendoWirePart(parsed.success ? parsed.data : (part as never));
    expect(wire.type).toBe("data-vendo-citations");
    expect(vendoCitationsPartSchema.safeParse({ type: wire.type, ...wire.data }).success).toBe(true);
  });

  it("accepts refusal and unavailable outcomes with empty citations", () => {
    for (const outcome of ["insufficient-evidence", "unavailable"]) {
      expect(vendoCitationsPartSchema.safeParse({
        type: "data-vendo-citations",
        toolCallId: "call_k1",
        outcome,
        citations: [],
      }).success).toBe(true);
    }
  });

  it("rejects a not-found outcome, a missing title, a wrong kind, and a missing visibility", () => {
    expect(vendoCitationsPartSchema.safeParse({
      type: "data-vendo-citations",
      toolCallId: "call_k1",
      outcome: "not-found",
      citations: [],
    }).success).toBe(false);
    expect(vendoCitationsPartSchema.safeParse({
      type: "data-vendo-citations",
      toolCallId: "call_k1",
      outcome: "answered",
      citations: [{ docId: "d1", kind: "docs", visibility: "public", snippet: "s" }],
    }).success).toBe(false);
    expect(vendoCitationsPartSchema.safeParse({
      type: "data-vendo-citations",
      toolCallId: "call_k1",
      outcome: "answered",
      citations: [{ docId: "d1", title: "T", kind: "notes", visibility: "public", snippet: "s" }],
    }).success).toBe(false);
    expect(vendoCitationsPartSchema.safeParse({
      type: "data-vendo-citations",
      toolCallId: "call_k1",
      outcome: "answered",
      citations: [{ docId: "d1", title: "T", kind: "docs", snippet: "s" }],
    }).success).toBe(false);
  });
});

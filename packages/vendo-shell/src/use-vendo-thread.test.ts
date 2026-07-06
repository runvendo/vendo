import { describe, it, expect } from "vitest";
import type { VendoUIMessage } from "@vendoai/core";
import { toThreadItems, groupThreadItems, originatingPrompt, type ThreadItem } from "./use-vendo-thread";

const msg = (id: string, role: "user" | "assistant", parts: unknown[]): VendoUIMessage =>
  ({ id, role, parts } as unknown as VendoUIMessage);

describe("toThreadItems", () => {
  it("flattens text parts with role", () => {
    const items = toThreadItems([msg("m1", "user", [{ type: "text", text: "hi" }])]);
    expect(items).toEqual([{ kind: "text", key: "m1:0", messageId: "m1", role: "user", text: "hi" }]);
  });

  it("emits an approval item for a tool part awaiting approval", () => {
    const items = toThreadItems([
      msg("m2", "assistant", [
        { type: "tool-budgetCreate", state: "approval-requested", approval: { id: "a1" }, input: { cap: 2000 } },
      ]),
    ]);
    expect(items[0]).toEqual({
      kind: "approval", key: "m2:0", messageId: "m2", approvalId: "a1", toolName: "budgetCreate", input: { cap: 2000 },
    });
  });

  it("emits an approval item for a DYNAMIC tool part awaiting approval (MCP tools)", () => {
    // MCP tools ingest as ai-SDK dynamic tools: their parts are type
    // "dynamic-tool" with the name in `toolName`, not "tool-<name>".
    const items = toThreadItems([
      msg("m2d", "assistant", [
        {
          type: "dynamic-tool",
          toolName: "everything_echo",
          state: "approval-requested",
          approval: { id: "a9" },
          input: { message: "hi" },
        },
      ]),
    ]);
    expect(items[0]).toEqual({
      kind: "approval", key: "m2d:0", messageId: "m2d", approvalId: "a9", toolName: "everything_echo", input: { message: "hi" },
    });
  });

  it("a DYNAMIC approval carries its toolCallId + sibling data-consent tier — the consent POST must not be dropped (MCP gap)", () => {
    // Without toolCallId the shell's approve() silently skipped the consent
    // POST for MCP tools, bypassing the audit/grant channel host tools use.
    const items = toThreadItems([
      msg("m2d", "assistant", [
        {
          type: "dynamic-tool",
          toolName: "everything_echo",
          toolCallId: "call-mcp-1",
          state: "approval-requested",
          approval: { id: "a9" },
          input: { message: "hi" },
        },
        { type: "data-consent", data: { toolCallId: "call-mcp-1", tier: "act", unverified: true } },
      ]),
    ]);
    expect(items[0]).toEqual({
      kind: "approval", key: "m2d:0", messageId: "m2d", approvalId: "a9", toolCallId: "call-mcp-1",
      toolName: "everything_echo", input: { message: "hi" }, tier: "act", unverified: true,
    });
  });

  it("emits a tool item for a dynamic tool part in other states", () => {
    const items = toThreadItems([
      msg("m3d", "assistant", [
        {
          type: "dynamic-tool",
          toolName: "everything_echo",
          toolCallId: "c1",
          state: "output-available",
          input: { message: "hi" },
          output: { content: [{ type: "text", text: "Echo: hi" }] },
        },
      ]),
    ]);
    expect(items[0]).toMatchObject({
      kind: "tool", toolName: "everything_echo", toolCallId: "c1", state: "output-available",
    });
  });

  it("emits an error item for an error part", () => {
    const items = toThreadItems([msg("m0", "assistant", [{ type: "error", errorText: "boom" }])]);
    expect(items[0]).toEqual({ kind: "error", key: "m0:0", messageId: "m0", message: "boom" });
  });

  it("suppresses the render_view tool chip (its product is the data-ui node)", () => {
    // Guards the RENDER_TOOLS set: dropping render_view would regress a chip.
    const items = toThreadItems([
      msg("m4", "assistant", [
        { type: "tool-render_view", state: "output-available" },
        { type: "data-ui", id: "ui-2", data: { id: "ui-2", kind: "component", source: "generated", name: "View", props: {} } },
      ]),
    ]);
    expect(items.some((i) => i.kind === "tool")).toBe(false);
    expect(items[0]).toMatchObject({ kind: "ui", key: "m4:1" });
  });

  it("suppresses the request_connect tool chip (its product is the Connect data-ui node)", () => {
    // Guards the RENDER_TOOLS set: the host-privileged Connect card is emitted as
    // a data-ui node, so its raw tool chip must be suppressed too.
    const items = toThreadItems([
      msg("m5", "assistant", [
        { type: "tool-request_connect", state: "output-available" },
        { type: "data-ui", id: "ui-3", data: { id: "ui-3", kind: "component", source: "host", name: "Connect", props: { toolkit: "gmail" } } },
      ]),
    ]);
    expect(items.some((i) => i.kind === "tool")).toBe(false);
    expect(items[0]).toMatchObject({ kind: "ui", key: "m5:1" });
  });

  it("emits a tool item for other tool states and a ui item for data-ui", () => {
    const items = toThreadItems([
      msg("m3", "assistant", [
        { type: "tool-budgetCreate", state: "output-available" },
        { type: "data-ui", id: "ui-1", data: { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} } },
      ]),
    ]);
    expect(items[0]).toEqual({ kind: "tool", key: "m3:0", messageId: "m3", toolName: "budgetCreate", state: "output-available" });
    expect(items[1]).toMatchObject({ kind: "ui", key: "m3:1" });
  });

  it("emits a file item for a file part", () => {
    const items = toThreadItems([
      msg("m4", "user", [{ type: "file", mediaType: "image/png", filename: "r.png", url: "data:x" }]),
    ]);
    expect(items[0]).toEqual({
      kind: "file", key: "m4:0", messageId: "m4", role: "user",
      mediaType: "image/png", filename: "r.png", url: "data:x",
    });
  });

  it("carries the streaming component name on a render tool skeleton when its input has one", () => {
    // renderName reads a partial input's `name` if present. Real render_view
    // payloads have no top-level name (→ nameless skeleton), but the machinery
    // still surfaces one when the streaming input carries it.
    const items = toThreadItems([
      msg("m5", "assistant", [
        { type: "tool-render_view", state: "input-streaming", input: { name: "SpendChart" } },
      ]),
    ]);
    expect(items[0]).toEqual({ kind: "skeleton", key: "m5:0", messageId: "m5", name: "SpendChart" });
  });

  it("emits a nameless skeleton while a render_view is streaming without a name", () => {
    const items = toThreadItems([
      msg("m6", "assistant", [{ type: "tool-render_view", state: "input-available", input: {} }]),
    ]);
    expect(items[0]).toEqual({ kind: "skeleton", key: "m6:0", messageId: "m6", name: undefined });
  });
});

describe("toThreadItems — remix fast-edits", () => {
  const uiPart = (id: string) => ({
    type: "data-ui",
    data: { id, kind: "generated", payload: { formatVersion: "vendo-genui/v1", root: "r", nodes: [] } },
  });
  const envPart = (uiNodeId: string, envelope = "sealed-blob") => ({
    type: "data-remix-envelope",
    data: { envelope, uiNodeId },
  });

  it("pairs an envelope to its ui item by node id (envelope AFTER the ui part)", () => {
    const items = toThreadItems([msg("a1", "assistant", [uiPart("view-1"), envPart("view-1")])]);
    expect(items).toHaveLength(1); // the envelope part emits no item of its own
    expect(items[0]).toMatchObject({ kind: "ui", envelope: "sealed-blob" });
  });

  it("pairs when the envelope streams BEFORE the ui part", () => {
    const items = toThreadItems([msg("a1", "assistant", [envPart("view-1"), uiPart("view-1")])]);
    expect(items[0]).toMatchObject({ kind: "ui", envelope: "sealed-blob" });
  });

  it("leaves unpaired ui items envelope-free; mismatched ids don't cross-pair", () => {
    const items = toThreadItems([
      msg("a1", "assistant", [uiPart("view-1"), envPart("view-OTHER"), uiPart("view-2")]),
    ]);
    const uis = items.filter((i) => i.kind === "ui");
    expect(uis).toHaveLength(2);
    for (const ui of uis) expect(ui.kind === "ui" && ui.envelope).toBeUndefined();
  });

  it("shows the pending skeleton for edit_view like render_view; suppresses its finished chip", () => {
    const streaming = toThreadItems([
      msg("a2", "assistant", [{ type: "tool-edit_view", state: "input-streaming", input: {} }]),
    ]);
    expect(streaming[0]?.kind).toBe("skeleton");
    const done = toThreadItems([
      msg("a3", "assistant", [{ type: "tool-edit_view", state: "output-available" }]),
    ]);
    expect(done).toHaveLength(0);
    const failed = toThreadItems([
      msg("a4", "assistant", [{ type: "tool-edit_view", state: "output-error", errorText: "mismatch" }]),
    ]);
    expect(failed[0]?.kind).toBe("error");
  });
});

describe("groupThreadItems", () => {
  it("collapses a turn's tool calls into a single activity group in place", () => {
    const items: ThreadItem[] = [
      { kind: "text", key: "m:0", messageId: "m", role: "assistant", text: "hi" },
      { kind: "tool", key: "m:1", messageId: "m", toolName: "a", state: "output-available" },
      { kind: "tool", key: "m:2", messageId: "m", toolName: "b", state: "output-available" },
      { kind: "ui", key: "m:3", messageId: "m", node: { id: "u", kind: "component", source: "prewired", name: "C", props: {} } },
    ];
    const grouped = groupThreadItems(items);
    expect(grouped.map((g) => g.kind)).toEqual(["text", "activity", "ui"]);
    const activity = grouped[1] as Extract<ReturnType<typeof groupThreadItems>[number], { kind: "activity" }>;
    expect(activity.steps).toHaveLength(2);
  });
});

describe("toThreadItems — consent tier correlation", () => {
  it("attaches tier/unverified/toolCallId to an approval item from its sibling data-consent part", () => {
    const items = toThreadItems([
      msg("m1", "assistant", [
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "call-1", state: "approval-requested",
          input: { to: "a@b.com" }, approval: { id: "ap-1" } },
        { type: "data-consent", data: { toolCallId: "call-1", tier: "act", unverified: true } },
      ]),
    ]);
    const approval = items.find((i) => i.kind === "approval");
    expect(approval).toMatchObject({ toolCallId: "call-1", tier: "act", unverified: true });
  });

  it("an approval with no matching data-consent part gets no tier (defensive — never crashes)", () => {
    const items = toThreadItems([
      msg("m2", "assistant", [{ type: "tool-x", toolCallId: "call-2", state: "approval-requested", input: {}, approval: { id: "ap-2" } }]),
    ]);
    const approval = items.find((i) => i.kind === "approval");
    expect(approval).toMatchObject({ toolCallId: "call-2" });
    expect((approval as { tier?: string }).tier).toBeUndefined();
  });

  it("a settled tool item also carries tier from its data-consent part (receipts)", () => {
    const items = toThreadItems([
      msg("m3", "assistant", [
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "call-3", state: "output-available", input: { to: "a@b.com" }, output: "sent" },
        { type: "data-consent", data: { toolCallId: "call-3", tier: "act", unverified: false } },
      ]),
    ]);
    const tool = items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ tier: "act" });
  });

  it("carries the escalation reason from a sibling data-consent part onto the approval item", () => {
    const items = toThreadItems([
      msg("m4", "assistant", [
        { type: "data-consent", data: { toolCallId: "call-1", tier: "act", unverified: false, reason: "an email I read asked for this" } },
        { type: "tool-send_email", toolCallId: "call-1", state: "approval-requested", input: {}, approval: { id: "ap-1" } },
      ]),
    ]);
    const approval = items.find((i) => i.kind === "approval");
    expect(approval).toMatchObject({ tier: "act", reason: "an email I read asked for this" });
  });

  it("omits reason when the sibling data-consent part carries none", () => {
    const items = toThreadItems([
      msg("m5", "assistant", [
        { type: "data-consent", data: { toolCallId: "call-1", tier: "act", unverified: false } },
        { type: "tool-send_email", toolCallId: "call-1", state: "approval-requested", input: {}, approval: { id: "ap-1" } },
      ]),
    ]);
    const approval = items.find((i) => i.kind === "approval");
    expect(approval).toMatchObject({ tier: "act" });
    expect((approval as { reason?: string }).reason).toBeUndefined();
  });
});

describe("groupThreadItems — batching sibling approvals", () => {
  it("groups 2+ approval-requested items of the SAME tool in the SAME message into one approval-batch", () => {
    const items = toThreadItems([
      msg("m4", "assistant", [
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c1", state: "approval-requested", input: { to: "a@b.com" }, approval: { id: "ap1" } },
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c2", state: "approval-requested", input: { to: "c@d.com" }, approval: { id: "ap2" } },
        { type: "data-consent", data: { toolCallId: "c1", tier: "act", unverified: false } },
        { type: "data-consent", data: { toolCallId: "c2", tier: "act", unverified: false } },
      ]),
    ]);
    const grouped = groupThreadItems(items);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ kind: "approval-batch", toolName: "GMAIL_SEND_EMAIL" });
    expect((grouped[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it("REVIEW FOLLOW-UP: an UNDEFINED tier (the data-consent sibling was lost) NEVER batches — two individual cards", () => {
    const items = toThreadItems([
      msg("m4b", "assistant", [
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c1", state: "approval-requested", input: { to: "a@b.com" }, approval: { id: "ap1" } },
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c2", state: "approval-requested", input: { to: "c@d.com" }, approval: { id: "ap2" } },
      ]),
    ]);
    const grouped = groupThreadItems(items);
    expect(grouped.every((g) => g.kind !== "approval-batch")).toBe(true);
    expect(grouped.filter((g) => g.kind === "approval")).toHaveLength(2);
  });

  it("REVIEW FOLLOW-UP: an undefined-tier sibling sharing a message+tool with act siblings stays out of their batch too", () => {
    const items = toThreadItems([
      msg("m4c", "assistant", [
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c1", state: "approval-requested", input: {}, approval: { id: "ap1" } },
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c2", state: "approval-requested", input: {}, approval: { id: "ap2" } },
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c3", state: "approval-requested", input: {}, approval: { id: "ap3" } },
        { type: "data-consent", data: { toolCallId: "c1", tier: "act", unverified: false } },
        { type: "data-consent", data: { toolCallId: "c2", tier: "act", unverified: false } },
        // c3 has no data-consent sibling at all -> tier undefined.
      ]),
    ]);
    const grouped = groupThreadItems(items);
    const batch = grouped.find((g) => g.kind === "approval-batch") as { items: { approvalId: string }[] } | undefined;
    expect(batch?.items.map((i) => i.approvalId)).toEqual(["ap1", "ap2"]);
    expect(grouped.filter((g) => g.kind === "approval")).toHaveLength(1); // the undefined-tier one, alone
  });

  it("does NOT batch a single approval, or approvals of DIFFERENT tools", () => {
    const items = toThreadItems([
      msg("m5", "assistant", [
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c1", state: "approval-requested", input: {}, approval: { id: "ap1" } },
        { type: "tool-GOOGLECALENDAR_CREATE_EVENT", toolCallId: "c2", state: "approval-requested", input: {}, approval: { id: "ap2" } },
      ]),
    ]);
    const grouped = groupThreadItems(items);
    expect(grouped.every((g) => g.kind !== "approval-batch")).toBe(true);
  });

  it("critical-tier siblings NEVER batch — each stays an individual ceremony card", () => {
    // Money invariant (spec §3 Moment 6/§4.1): a batch "Approve all N" would
    // bypass the ceremony register and its untruncated fields.
    const items = toThreadItems([
      msg("m6", "assistant", [
        { type: "tool-transfer_money", toolCallId: "c1", state: "approval-requested", input: {}, approval: { id: "ap1" } },
        { type: "tool-transfer_money", toolCallId: "c2", state: "approval-requested", input: {}, approval: { id: "ap2" } },
        { type: "data-consent", data: { toolCallId: "c1", tier: "critical", unverified: false } },
        { type: "data-consent", data: { toolCallId: "c2", tier: "critical", unverified: false } },
      ]),
    ]);
    const grouped = groupThreadItems(items);
    expect(grouped.filter((g) => g.kind === "approval")).toHaveLength(2);
    expect(grouped.some((g) => g.kind === "approval-batch")).toBe(false);
  });

  it("a critical sibling sharing a message+tool with act siblings stays out of their batch", () => {
    const items = toThreadItems([
      msg("m7", "assistant", [
        { type: "tool-transfer_money", toolCallId: "c1", state: "approval-requested", input: {}, approval: { id: "ap1" } },
        { type: "tool-transfer_money", toolCallId: "c2", state: "approval-requested", input: {}, approval: { id: "ap2" } },
        { type: "tool-transfer_money", toolCallId: "c3", state: "approval-requested", input: {}, approval: { id: "ap3" } },
        { type: "data-consent", data: { toolCallId: "c1", tier: "act", unverified: false } },
        { type: "data-consent", data: { toolCallId: "c2", tier: "act", unverified: false } },
        { type: "data-consent", data: { toolCallId: "c3", tier: "critical", unverified: false } },
      ]),
    ]);
    const grouped = groupThreadItems(items);
    const batch = grouped.find((g) => g.kind === "approval-batch") as { items: { approvalId: string }[] } | undefined;
    expect(batch?.items.map((i) => i.approvalId)).toEqual(["ap1", "ap2"]);
    expect(grouped.filter((g) => g.kind === "approval")).toHaveLength(1); // the critical one, alone
  });

  it("REGRESSION (ENG-193 PR #40 review — item C): a reasoned act-tier sibling never batches — it renders its own individual card", () => {
    const items = toThreadItems([
      msg("m8", "assistant", [
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c1", state: "approval-requested", input: {}, approval: { id: "ap1" } },
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c2", state: "approval-requested", input: {}, approval: { id: "ap2" } },
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c3", state: "approval-requested", input: {}, approval: { id: "ap3" } },
        { type: "data-consent", data: { toolCallId: "c1", tier: "act", unverified: false } },
        { type: "data-consent", data: { toolCallId: "c2", tier: "act", unverified: false } },
        // c3 shares the same tool/message as c1/c2 but carries an escalation
        // reason (judge/breaker "Hold on") — must NOT be swept into the batch.
        { type: "data-consent", data: { toolCallId: "c3", tier: "act", unverified: false, reason: "unusual volume" } },
      ]),
    ]);
    const grouped = groupThreadItems(items);
    const batch = grouped.find((g) => g.kind === "approval-batch") as { items: { approvalId: string }[] } | undefined;
    expect(batch?.items.map((i) => i.approvalId)).toEqual(["ap1", "ap2"]);
    const solo = grouped.filter((g) => g.kind === "approval") as Extract<ReturnType<typeof groupThreadItems>[number], { kind: "approval" }>[];
    expect(solo).toHaveLength(1); // the reasoned one, alone
    expect(solo[0]?.approvalId).toBe("ap3");
    expect((solo[0] as { reason?: string }).reason).toBe("unusual volume");
  });
});

describe("groupThreadItems — batching excludes unverified act-tier calls", () => {
  it("REVIEW FOLLOW-UP: two UNVERIFIED same-tool act-tier siblings never batch — ApprovalBatchCard has no unverified tag, so each renders its own individual card", () => {
    const items = toThreadItems([
      msg("m9", "assistant", [
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c1", state: "approval-requested", input: {}, approval: { id: "ap1" } },
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c2", state: "approval-requested", input: {}, approval: { id: "ap2" } },
        { type: "data-consent", data: { toolCallId: "c1", tier: "act", unverified: true } },
        { type: "data-consent", data: { toolCallId: "c2", tier: "act", unverified: true } },
      ]),
    ]);
    const grouped = groupThreadItems(items);
    expect(grouped.every((g) => g.kind !== "approval-batch")).toBe(true);
    expect(grouped.filter((g) => g.kind === "approval")).toHaveLength(2);
  });

  it("REVIEW FOLLOW-UP: an unverified sibling sharing a message+tool with verified act siblings stays out of their batch", () => {
    const items = toThreadItems([
      msg("m10", "assistant", [
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c1", state: "approval-requested", input: {}, approval: { id: "ap1" } },
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c2", state: "approval-requested", input: {}, approval: { id: "ap2" } },
        { type: "tool-GMAIL_SEND_EMAIL", toolCallId: "c3", state: "approval-requested", input: {}, approval: { id: "ap3" } },
        { type: "data-consent", data: { toolCallId: "c1", tier: "act", unverified: false } },
        { type: "data-consent", data: { toolCallId: "c2", tier: "act", unverified: false } },
        { type: "data-consent", data: { toolCallId: "c3", tier: "act", unverified: true } },
      ]),
    ]);
    const grouped = groupThreadItems(items);
    const batch = grouped.find((g) => g.kind === "approval-batch") as { items: { approvalId: string }[] } | undefined;
    expect(batch?.items.map((i) => i.approvalId)).toEqual(["ap1", "ap2"]);
    expect(grouped.filter((g) => g.kind === "approval")).toHaveLength(1); // the unverified one, alone
  });
});

describe("originatingPrompt", () => {
  it("finds the nearest preceding user text", () => {
    const items = [
      { kind: "text", key: "m1:0", messageId: "m1", role: "user", text: "show my spending" },
      { kind: "text", key: "m2:0", messageId: "m2", role: "assistant", text: "sure" },
      { kind: "ui", key: "m2:1", messageId: "m2", node: { id: "v", kind: "generated", payload: {} } },
    ] as ThreadItem[];
    expect(originatingPrompt(items, "m2:1")).toBe("show my spending");
    expect(originatingPrompt(items, "missing")).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import type { FlowletUIMessage } from "@flowlet/core";
import { toThreadItems, groupThreadItems, originatingPrompt, type ThreadItem } from "./use-flowlet-thread";

const msg = (id: string, role: "user" | "assistant", parts: unknown[]): FlowletUIMessage =>
  ({ id, role, parts } as unknown as FlowletUIMessage);

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

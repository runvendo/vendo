import { describe, it, expect } from "vitest";
import type { FlowletUIMessage } from "@flowlet/core";
import { toThreadItems } from "./use-flowlet-thread";

const msg = (id: string, role: "user" | "assistant", parts: unknown[]): FlowletUIMessage =>
  ({ id, role, parts } as unknown as FlowletUIMessage);

describe("toThreadItems", () => {
  it("flattens text parts with role", () => {
    const items = toThreadItems([msg("m1", "user", [{ type: "text", text: "hi" }])]);
    expect(items).toEqual([{ kind: "text", key: "m1:0", role: "user", text: "hi" }]);
  });

  it("emits an approval item for a tool part awaiting approval", () => {
    const items = toThreadItems([
      msg("m2", "assistant", [
        { type: "tool-budgetCreate", state: "approval-requested", approval: { id: "a1" }, input: { cap: 2000 } },
      ]),
    ]);
    expect(items[0]).toEqual({
      kind: "approval", key: "m2:0", approvalId: "a1", toolName: "budgetCreate", input: { cap: 2000 },
    });
  });

  it("emits an error item for an error part", () => {
    const items = toThreadItems([msg("m0", "assistant", [{ type: "error", errorText: "boom" }])]);
    expect(items[0]).toEqual({ kind: "error", key: "m0:0", message: "boom" });
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
    expect(items[0]).toEqual({ kind: "tool", key: "m3:0", toolName: "budgetCreate", state: "output-available" });
    expect(items[1]).toMatchObject({ kind: "ui", key: "m3:1" });
  });
});

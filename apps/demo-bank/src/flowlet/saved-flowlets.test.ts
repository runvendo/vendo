import { describe, it, expect } from "vitest";
import type { ThreadItem } from "@flowlet/shell";
import { deriveSavedDrafts } from "./saved-flowlets";

const gen = (id: string): ThreadItem => ({
  kind: "ui",
  key: `m2:${id}`,
  messageId: "m2",
  node: { id, kind: "generated", payload: { formatVersion: "flowlet-genui/v1", root: "n1", nodes: [] } },
});

const items: ThreadItem[] = [
  { kind: "text", key: "m1:0", messageId: "m1", role: "user", text: "show my late-night spending" },
  gen("view-1"),
  {
    kind: "ui",
    key: "m2:c",
    messageId: "m2",
    node: { id: "connect-1", kind: "component", source: "host", name: "Connect", props: {} },
  },
];

describe("deriveSavedDrafts", () => {
  it("captures generated views with their originating prompt, skipping Connect cards and known ids", () => {
    const drafts = deriveSavedDrafts(items, new Set());
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ id: "view-1", prompt: "show my late-night spending" });
    expect(drafts[0]!.name).toBe("show my late-night spending");
    expect(deriveSavedDrafts(items, new Set(["view-1"]))).toHaveLength(0);
  });

  it("truncates long prompts into readable names", () => {
    const long = "please build me a very detailed dashboard about everything I have ever spent money on";
    const drafts = deriveSavedDrafts(
      [{ kind: "text", key: "m1:0", messageId: "m1", role: "user", text: long }, gen("v2")],
      new Set(),
    );
    expect(drafts[0]!.name.length).toBeLessThanOrEqual(48);
    expect(drafts[0]!.prompt).toBe(long);
  });
});

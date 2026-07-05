import { describe, it, expect } from "vitest";
import { isComponentNode, isGeneratedNode, type UINode } from "./ui.js";

describe("UINode", () => {
  it("discriminates component vs generated", () => {
    const comp: UINode = { id: "n1", kind: "component", source: "prewired", name: "Card", props: {} };
    const gen: UINode = { id: "n2", kind: "generated", payload: { anything: true } };
    expect(isComponentNode(comp)).toBe(true);
    expect(isGeneratedNode(comp)).toBe(false);
    expect(isGeneratedNode(gen)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { KnowledgeDoc } from "@vendoai/core";
import { structuralChunker } from "./chunker.js";

const doc = (text: string, kind: KnowledgeDoc["kind"] = "docs"): KnowledgeDoc => ({
  id: "docs#guide.md",
  kind,
  visibility: "public",
  title: "Guide",
  text,
  source: "guide.md",
});

describe("structuralChunker", () => {
  it("declares version 1", () => {
    expect(structuralChunker.version).toBe(1);
  });

  it("splits prose at heading boundaries with accumulated heading paths", () => {
    const chunks = structuralChunker.chunk(doc([
      "# Guide",
      "Intro paragraph.",
      "## Install",
      "Install text.",
      "### macOS",
      "Brew text.",
      "## Usage",
      "Usage text.",
    ].join("\n")));
    expect(chunks.map((chunk) => chunk.heading)).toEqual([
      "Guide",
      "Guide > Install",
      "Guide > Install > macOS",
      "Guide > Usage",
    ]);
    // The h2 after the h3 pops back to the h1's child level.
    expect(chunks[3]!.text).toContain("Usage text.");
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2, 3]);
    expect(chunks.every((chunk) => chunk.docId === "docs#guide.md")).toBe(true);
  });

  it("never splits on a heading inside a fenced code block", () => {
    const chunks = structuralChunker.chunk(doc([
      "# Guide",
      "```md",
      "# not a heading",
      "## also not",
      "```",
      "After the fence.",
      "~~~",
      "```",
      "# still fenced (inner backticks do not close a tilde fence)",
      "~~~",
      "Tail.",
    ].join("\n")));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("# not a heading");
    expect(chunks[0]!.text).toContain("still fenced");
  });

  it("applies the size budget at blank-line boundaries, keeping fences whole", () => {
    const paragraph = "word ".repeat(100).trim(); // ~500 chars
    const fence = ["```ts", `const x = "${"y".repeat(600)}";`, "", `const z = "${"w".repeat(600)}";`, "```"].join("\n");
    const chunks = structuralChunker.chunk(doc(["## Big", paragraph, "", paragraph, "", paragraph, "", fence].join("\n")));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.heading === "Big")).toBe(true);
    // The fence, though over budget on its own, arrives intact in one chunk.
    const fenced = chunks.find((chunk) => chunk.text.includes("const x"));
    expect(fenced?.text).toContain("const z");
    // No boundary landed mid-paragraph: every chunk holds whole paragraphs.
    for (const chunk of chunks) {
      if (chunk.text.includes("word")) expect(chunk.text).toMatch(/word$|word\n|word `|```/);
    }
  });

  it("chunks glossary/api docs one entry per term, budget-exempt", () => {
    const long = "definition ".repeat(200).trim(); // far over the 1200 budget
    const chunks = structuralChunker.chunk(doc([
      "## Alpha",
      long,
      "## Beta",
      "Short definition.",
    ].join("\n"), "glossary"));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.heading).toBe("Alpha");
    expect(chunks[0]!.text).toContain(long);
    expect(chunks[1]!.heading).toBe("Beta");
  });

  it("mints stable chunk ids across runs", () => {
    const input = doc("# A\ntext\n## B\nmore");
    const first = structuralChunker.chunk(input);
    const second = structuralChunker.chunk(input);
    expect(first.map((chunk) => chunk.chunkId)).toEqual(second.map((chunk) => chunk.chunkId));
    expect(first[0]!.chunkId).toBe("docs#guide.md#0");
  });
});

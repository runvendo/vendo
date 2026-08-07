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

  it("tracks fences opened inside list items — the checker's `- ```md` probe (fix 2)", () => {
    const chunks = structuralChunker.chunk(doc([
      "# Guide",
      "- ```md",
      "  # not a heading (fenced inside a list item)",
      "  ```",
      "# Real",
      "Body after the list fence.",
    ].join("\n")));
    expect(chunks.map((chunk) => chunk.heading)).toEqual(["Guide", "Real"]);
    expect(chunks[0]!.text).toContain("# not a heading");
    expect(chunks[1]!.text).toContain("Body after the list fence.");
  });

  it("a list marker inside an open fence is content, never a closer", () => {
    const chunks = structuralChunker.chunk(doc([
      "# Guide",
      "```",
      "- ``` this line is fence content",
      "# still fenced",
      "```",
      "tail",
    ].join("\n")));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("# still fenced");
  });

  it("subdivides oversized blocks so a heading-free huge doc never becomes one giant chunk (fix 3)", () => {
    const sentence = "This corpus sentence carries a fixed amount of retrievable text for the checker probe. ";
    const monolith = sentence.repeat(120).trim(); // ~10k chars, ONE block, no headings
    const chunks = structuralChunker.chunk(doc(monolith));
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(1200);
    // Nothing lost: the pieces reassemble the full text.
    expect(chunks.map((chunk) => chunk.text).join(" ")).toBe(monolith);

    // No sentence boundaries at all → still bounded via hard split.
    const unbroken = "x".repeat(5000);
    const hard = structuralChunker.chunk(doc(unbroken));
    expect(hard.every((chunk) => chunk.text.length <= 1200)).toBe(true);
    expect(hard.map((chunk) => chunk.text).join("")).toBe(unbroken);
  });

  it("caps even fenced blocks — nothing is unbounded", () => {
    const giantFence = ["```", ...Array.from({ length: 400 }, (_, i) => `line ${i} ${"y".repeat(20)}`), "```"].join("\n");
    const chunks = structuralChunker.chunk(doc(`# Big\n\n${giantFence}`));
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(4800);
    expect(chunks.length).toBeGreaterThan(1);
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

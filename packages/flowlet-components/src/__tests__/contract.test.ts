import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { descriptors, prewiredComponents } from "../descriptors";
import { prewiredImpls } from "../impls";

describe("prewired contract", () => {
  it("every descriptor has exactly one impl and vice versa", () => {
    const descNames = descriptors.map((d) => d.name).sort();
    const implNames = Object.keys(prewiredImpls).sort();
    expect(implNames).toEqual(descNames);
  });

  it("all descriptors are stamped source=prewired", () => {
    expect(prewiredComponents.every((c) => c.source === "prewired")).toBe(true);
  });

  it("prewired names are globally unique", () => {
    const names = descriptors.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every props schema is JSON-Schema convertible", () => {
    for (const d of descriptors) {
      expect(() => zodToJsonSchema(d.propsSchema as never)).not.toThrow();
    }
  });

  it("the descriptors entrypoint exposes a non-empty descriptor array", async () => {
    const mod = await import("../descriptors");
    expect(Array.isArray(mod.descriptors)).toBe(true);
    expect(mod.descriptors.length).toBeGreaterThan(0);
  });
});

// Fix 5: JSON round-trip contract — representative valid props survive JSON parse/stringify
describe("JSON round-trip contract (§8)", () => {
  /** Minimal valid props for each descriptor, keyed by descriptor name. */
  const samples: Record<string, unknown> = {
    Card: { title: "My Card" },
    Table: {
      columns: [{ key: "name", label: "Name" }],
      rows: [{ name: "Alice" }],
    },
    Chart: {
      kind: "bar",
      categoryKey: "month",
      series: ["sales"],
      data: [{ month: "Jan", sales: 100 }],
    },
    Form: {
      submitLabel: "Submit",
      fields: [{ type: "text", name: "email", label: "Email" }],
    },
    Accordion: {
      items: [{ title: "FAQ 1", content: "Answer 1" }],
    },
    Carousel: {
      items: [{ title: "Slide 1", body: "Body text" }],
    },
    Callout: {
      variant: "info",
      text: "This is a callout.",
    },
    Tags: {
      items: [{ text: "React", variant: "info" }],
    },
    Steps: {
      steps: [{ title: "Step 1", text: "Do this first." }],
    },
    List: {
      items: [{ title: "Item A", subtitle: "Details" }],
    },
    Image: {
      src: "https://example.com/image.png",
      alt: "An example image",
    },
    ImageGallery: {
      images: [{ src: "https://example.com/img1.png", alt: "First" }],
    },
    Markdown: {
      content: "## Hello\n\nThis is **markdown**.",
    },
    CodeBlock: {
      code: "const x = 1;",
      language: "typescript",
    },
    Tabs: {
      tabs: [{ label: "Overview", content: "Overview content." }],
    },
  };

  it("every descriptor's representative props survive JSON round-trip and re-validate", () => {
    for (const d of descriptors) {
      const sample = samples[d.name];
      expect(sample, `Missing sample for descriptor "${d.name}"`).toBeDefined();
      const roundTripped = JSON.parse(JSON.stringify(sample));
      const result = d.propsSchema.safeParse(roundTripped);
      expect(
        result.success,
        `"${d.name}" failed JSON round-trip: ${JSON.stringify((result as { error?: { message?: string } }).error?.message)}`,
      ).toBe(true);
    }
  });
});

// Fix 6: Descriptors module-graph must not pull in React or OpenUI
describe("descriptors React-free guard", () => {
  const BANNED_IMPORTS = [
    "@openuidev/react-ui",
    "../../openui",
    "../openui",
    "./openui",
    "react",
    "/impl",
  ];

  const PKG_ROOT =
    "/Users/yousefh/orca/workspaces/flowlet/eng-181-component-library/packages/flowlet-components";
  const COMPONENTS_DIR = join(PKG_ROOT, "src", "components");

  // Discover per-component descriptor files via readdirSync
  const componentDescriptorFiles = readdirSync(COMPONENTS_DIR)
    .map((name) => `src/components/${name}/descriptor.ts`);

  const descriptorFiles = [
    "src/descriptors.ts",
    "src/descriptor.ts",
    ...componentDescriptorFiles,
  ];

  it("no descriptor source file imports React, OpenUI, or impl files", () => {
    for (const relPath of descriptorFiles) {
      const absPath = join(PKG_ROOT, relPath);
      const src = readFileSync(absPath, "utf8");
      for (const banned of BANNED_IMPORTS) {
        // Match `from "..."` import statements
        const importPattern = new RegExp(
          `from\\s+["']([^"']*${banned.replace(/[+.]/g, "\\$&")}[^"']*)["']`,
        );
        const match = importPattern.exec(src);
        expect(
          match,
          `${relPath} imports a banned module matching "${banned}": found "${match?.[0]}"`,
        ).toBeNull();
      }
    }
  });
});

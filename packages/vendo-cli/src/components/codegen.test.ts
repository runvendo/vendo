import { describe, expect, it } from "vitest";
import { descriptorSource, implSource, entrySource, registryName, assertParses, assertSchemaValid, exampleProps } from "./codegen.js";
import type { ComponentAnalysis } from "./analyze.js";
import type { ComponentCandidate } from "./scan.js";

const analysis: ComponentAnalysis = {
  include: true,
  reason: "reusable primitive",
  name: "Button",
  description: "A styled button with variants.",
  imports: ["Button"],
  props: [
    { name: "label", type: "string", optional: false, description: "Button text." },
    { name: "variant", type: "enum", enumValues: ["primary", "ghost"], optional: true, description: "Visual style." },
  ],
  jsx: "<Button variant={p.variant}>{p.label}</Button>",
};
const candidate: ComponentCandidate = {
  file: "/x/src/components/ui/button.tsx",
  relFile: "src/components/ui/button.tsx",
  exportName: "Button",
  exportNames: ["Button"],
  source: "",
};

describe("codegen", () => {
  it("emits a descriptor matching RegisteredComponent with source host", () => {
    const src = descriptorSource(analysis);
    expect(src).toContain('source: "host"');
    expect(src).toContain('z.enum(["primary", "ghost"])');
    assertParses("descriptor", src);
  });

  it("emits a wrapper that imports the host file relatively and safeParses props", () => {
    const src = implSource(analysis, candidate);
    expect(src).toContain('from "../../../src/components/ui/button"');
    expect(src).toContain("safeParse");
    // Wrapper name must not collide with the imported host symbol.
    expect(src).toContain("export function ButtonWrapper(");
    assertParses("impl", src);
  });

  it("prefixes names that collide with prewired components", () => {
    expect(registryName({ ...analysis, name: "Card" })).toBe("HostCard");
    expect(registryName(analysis)).toBe("Button");
  });

  it("analysis schema accepts non-PascalCase names on include:false replies", async () => {
    const { componentAnalysisSchema } = await import("./analyze.js");
    expect(() =>
      componentAnalysisSchema.parse({
        include: false, reason: "page-level", name: "n/a", description: "", imports: [], props: [], jsx: "",
      }),
    ).not.toThrow();
  });

  it("writeComponent rejects non-PascalCase names for included components", async () => {
    const { writeComponent } = await import("./codegen.js");
    await expect(
      writeComponent("/tmp/nowhere", { ...analysis, name: "bad-name" }, candidate, { force: false }),
    ).rejects.toThrow(/PascalCase/);
  });

  it("normalizes statement-shaped import entries to bare names", async () => {
    const { normalizeImports } = await import("./codegen.js");
    expect(normalizeImports(["Button"])).toEqual(["Button"]);
    expect(normalizeImports(['import { Card, CardHeader } from "@/components/ui/card"'])).toEqual([
      "Card",
      "CardHeader",
    ]);
    expect(normalizeImports(["src/components/charts/bars.tsx"])).toEqual([]);
  });

  it("derives imports from JSX tags restricted to real exports when the list is unusable", async () => {
    const { importsFromJsx, implSource } = await import("./codegen.js");
    expect(importsFromJsx("<Button>{p.label}</Button>", ["Button"])).toEqual(["Button"]);
    expect(importsFromJsx("<Leaf size={16} />", ["MapleMark"])).toEqual([]);
    const src = implSource({ ...analysis, imports: ["src/components/ui/button.tsx"] }, candidate);
    expect(src).toContain('import { Button } from "../../../src/components/ui/button"');
  });

  it("rejects broken generated JSX", () => {
    expect(() => assertParses("impl", "const x = <div>")).toThrow(/syntax error/);
  });

  describe("assertSchemaValid", () => {
    it("passes a healthy descriptor (schema evaluates and accepts its own example)", () => {
      expect(() => assertSchemaValid(analysis)).not.toThrow();
    });

    it("synthesizes a type-appropriate example object accepted by a healthy schema", () => {
      expect(exampleProps(analysis.props)).toEqual({ label: "example", variant: "primary" });
    });

    it("detects a degenerate empty enum (z.enum([]) rejects every input)", () => {
      const bad: ComponentAnalysis = {
        ...analysis,
        props: [{ name: "status", type: "enum", enumValues: [], optional: false, description: "Status." }],
      };
      expect(() => assertSchemaValid(bad)).toThrow(/degenerate/);
      expect(() => assertSchemaValid(bad)).toThrow(/empty enum for "status"/);
    });

    it("detects a degenerate empty enum even when the prop is optional", () => {
      const bad: ComponentAnalysis = {
        ...analysis,
        props: [{ name: "status", type: "enum", enumValues: undefined, optional: true, description: "Status." }],
      };
      expect(() => assertSchemaValid(bad)).toThrow(/rejects its own example props/);
    });

    it("guards against a non-identifier prop name before evaluating", () => {
      const bad: ComponentAnalysis = {
        ...analysis,
        props: [{ name: "x); throw new Error('pwned'); (", type: "string", optional: false, description: "d" }],
      };
      expect(() => assertSchemaValid(bad)).toThrow(/not a valid identifier/);
    });
  });

  it("re-roots tsconfig path aliases for the emitted vite config", async () => {
    const { aliasesFromTsconfigPaths, viteConfigSource } = await import("./codegen.js");
    expect(aliasesFromTsconfigPaths({ "@/*": ["./src/*"], "~lib": ["./lib"] })).toEqual({ "@": "../../src" });
    const cfg = viteConfigSource({ "@": "../../src" });
    expect(cfg).toContain('"@": path.resolve(here, "../../src")');
    assertParses("vite.config", cfg);
  });

  it("entry source wires the __VENDO_HOST__ contract", () => {
    const src = entrySource(["Button"]);
    expect(src).toContain("window.__VENDO_HOST__ = { Button: ButtonWrapper }");
    expect(src).toContain('import { ButtonWrapper } from "./Button/impl";');
    assertParses("entry", src);
  });
});

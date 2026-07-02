import { describe, expect, it } from "vitest";
import { descriptorSource, implSource, entrySource, registryName, assertParses } from "./codegen.js";
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

  it("rejects broken generated JSX", () => {
    expect(() => assertParses("impl", "const x = <div>")).toThrow(/syntax error/);
  });

  it("entry source wires the __FLOWLET_HOST__ contract", () => {
    const src = entrySource(["Button"]);
    expect(src).toContain("window.__FLOWLET_HOST__ = { Button: ButtonWrapper }");
    expect(src).toContain('import { ButtonWrapper } from "./Button/impl";');
    assertParses("entry", src);
  });
});

import { describe, it, expect } from "vitest";
import { compileComponentSource } from "./compile-component";

describe("compileComponentSource", () => {
  it("compiles JSX to automatic-runtime jsx imports", () => {
    const out = compileComponentSource(
      "export default function A(){ return <div className='x'>hi</div>; }",
    );
    expect(out).toContain("react/jsx-runtime");
    expect(out).toMatch(/\bjsx\b/);
    expect(out).not.toContain("<div");
  });

  it("uses PRODUCTION mode (no jsxDEV, which the shim does not export)", () => {
    const out = compileComponentSource(
      "export default function A(){ return <span>hi</span>; }",
    );
    expect(out).not.toContain("jsxDEV");
  });

  it("strips TypeScript type annotations", () => {
    const out = compileComponentSource(
      "export default function A(props: {n: number}){ return null as any; }",
    );
    expect(out).not.toContain(": {n: number}");
    expect(out).not.toContain("as any");
  });

  it("passes plain createElement JS through unchanged (no jsx-runtime added)", () => {
    const out = compileComponentSource(
      "import React from \"react\"; export default function A(){ return React.createElement(\"div\", null, \"hi\"); }",
    );
    expect(out).toContain("React.createElement");
    expect(out).not.toContain("react/jsx-runtime");
  });

  it("throws on a syntax error", () => {
    expect(() => compileComponentSource("export default function ( {")).toThrow();
  });
});

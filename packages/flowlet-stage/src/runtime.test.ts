import { describe, it, expect } from "vitest";
import { STAGE_RUNTIME_SRC } from "./runtime";

describe("stage runtime source", () => {
  it("is parseable JS", () => {
    expect(() => new Function(STAGE_RUNTIME_SRC)).not.toThrow();
  });
  it("includes the required capabilities", () => {
    for (const marker of [
      "ui/initialize", "ui/update", "ui/action-result", "ui/teardown", "__flowletDispatch",
      "ResizeObserver", "$state", "getDerivedStateFromError", "__React",
    ]) expect(STAGE_RUNTIME_SRC).toContain(marker);
  });
  it("defines the built-in prewired primitives", () => {
    for (const marker of [
      "PRIMITIVES", "Stack", "Row", "Grid", "Text", "Skeleton",
      "data-skeleton", "data-primitive",
    ]) expect(STAGE_RUNTIME_SRC).toContain(marker);
  });
  it("resolves prewired names against primitives first, falling back to host", () => {
    expect(STAGE_RUNTIME_SRC).toContain('node.source === "prewired"');
    // Fallback to the host bundle (e.g. __row/__badge) must be preserved.
    expect(STAGE_RUNTIME_SRC).toContain("host[node.name]");
  });
  it("caches the error-boundary class so ui/update reconciles instead of remounting", () => {
    // The class is built once via getEB() and reused, mirroring cachedHost. A
    // fresh makeEB() per render would be a new React component type and force a
    // full remount on every ui/update, destroying DOM identity.
    expect(STAGE_RUNTIME_SRC).toContain("function getEB()");
    expect(STAGE_RUNTIME_SRC).toContain("cachedEB || (cachedEB = makeEB(window.__React))");
    // makeEB must NOT be called directly inside render()/rerender() anymore.
    expect(STAGE_RUNTIME_SRC).not.toContain("var EB = makeEB(");
  });
  it("resets the cached error boundary when its child changes so ui-delta recovers", () => {
    // Without a reset, a node that throws once stays "render error" forever even
    // after a valid ui/update. componentDidUpdate clears err when children change.
    expect(STAGE_RUNTIME_SRC).toContain("componentDidUpdate");
    expect(STAGE_RUNTIME_SRC).toContain("this.setState({ err: false })");
    expect(STAGE_RUNTIME_SRC).toContain("prevProps.children !== this.props.children");
  });
});

describe("$state prop binding (bindProps)", () => {
  // Extract and execute the REAL bindProps implementation from the runtime source
  // so the test pins the actual shipped behavior, not a copy.
  const src = STAGE_RUNTIME_SRC.match(/function bindProps\(props, state\) \{[\s\S]*?\n  \}/)![0];
  const bindProps = new Function(`${src}; return bindProps;`)() as (
    props: Record<string, unknown>,
    state: Record<string, unknown>,
  ) => Record<string, unknown>;

  it("resolves $state references at the top level only; nested/array refs pass through unresolved", () => {
    const state = { acct: "Checking ****1234" };
    const out = bindProps(
      {
        name: { $state: "acct" },             // top-level ref → resolved
        nested: { obj: { $state: "acct" } },  // nested ref → passed through as-is
        arr: [{ $state: "acct" }],            // array ref → passed through as-is
        plain: "x",
      },
      state,
    );
    expect(out.name).toBe("Checking ****1234");
    expect(out.nested).toEqual({ obj: { $state: "acct" } });
    expect(out.arr).toEqual([{ $state: "acct" }]);
    expect(out.plain).toBe("x");
  });
});

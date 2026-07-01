import { describe, it, expect } from "vitest";
import { RESERVED_COMPONENT_NAMES } from "@flowlet/core";
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
  it("implements every name core reserves for prewired primitives (drift guard)", () => {
    // RESERVED_COMPONENT_NAMES in @flowlet/core blocks generated components from
    // shadowing these; each must exist as a key in the PRIMITIVES table here.
    for (const name of RESERVED_COMPONENT_NAMES) {
      expect(STAGE_RUNTIME_SRC).toContain(`${name}:`);
    }
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
  it("allowlists the Text primitive's as-tag to safe text elements", () => {
    // props.as is LLM-controlled; only text tags are permitted, else fall back to span.
    expect(STAGE_RUNTIME_SRC).toContain("TEXT_TAGS");
    expect(STAGE_RUNTIME_SRC).toContain(
      "span:1, p:1, h1:1, h2:1, h3:1, h4:1, h5:1, h6:1, strong:1, em:1, small:1, label:1, div:1",
    );
    // The raw, unguarded passthrough must be gone.
    expect(STAGE_RUNTIME_SRC).not.toContain('R.createElement(props.as || "span"');
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

describe("generated components (Tier 2.5)", () => {
  it("loads generated component modules per-name with error sentinels", () => {
    for (const marker of [
      "function loadGeneratedComponents(",
      "generatedErrors",
      "cachedGenerated",
      'typeof mod.default === "function"',
    ]) expect(STAGE_RUNTIME_SRC).toContain(marker);
  });
  it("resolves source 'generated' against the generated map with contained errors", () => {
    expect(STAGE_RUNTIME_SRC).toContain('node.source === "generated"');
    expect(STAGE_RUNTIME_SRC).toContain('"data-error": "generated:"');
  });
  it("passes a per-node flowlet.dispatch closure to generated components", () => {
    expect(STAGE_RUNTIME_SRC).toContain("boundProps.flowlet");
    expect(STAGE_RUNTIME_SRC).toContain("window.__flowletDispatch(descriptor, node.id)");
  });
  it("no longer renders the '[generated]' placeholder branch", () => {
    expect(STAGE_RUNTIME_SRC).not.toContain('"[generated]"');
  });
});

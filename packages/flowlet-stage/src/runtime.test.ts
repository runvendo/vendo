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

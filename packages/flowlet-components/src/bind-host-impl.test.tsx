import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { z } from "zod";
import { hostComponent } from "./host-component";
import { bindHostImpl } from "./bind-host-impl";

const descriptor = hostComponent(
  "Sparkline",
  "A tiny line chart.",
  z.object({ data: z.array(z.number()).min(1) }),
);

describe("bindHostImpl", () => {
  it("renders through the adapter when props validate", () => {
    const Impl = bindHostImpl(descriptor, (p) => <div data-testid="spark">{p.data.length} points</div>);
    render(<Impl data={[1, 2, 3]} />);
    expect(screen.getByTestId("spark").textContent).toBe("3 points");
  });

  it("renders the inline fallback (never throws) on schema-invalid props", () => {
    const Impl = bindHostImpl(descriptor, (p) => <div data-testid="spark">{p.data.length}</div>);
    render(<Impl data="not-an-array" />);
    expect(screen.queryByTestId("spark")).toBeNull();
    expect(screen.getByTestId("flowlet-invalid-props")).toBeTruthy();
  });

  it("contains render-time throws from the host component behind the error boundary", () => {
    const Impl = bindHostImpl(descriptor, () => {
      throw new Error("host component exploded");
    });
    render(<Impl data={[1]} />);
    expect(screen.getByTestId("flowlet-invalid-props")).toBeTruthy();
  });

  it("hands the runtime dispatch capability to the adapter as a second argument (review finding)", () => {
    const dispatch = async () => ({ ok: true });
    let seen: unknown = null;
    const Impl = bindHostImpl(descriptor, (_p, runtime) => {
      seen = runtime;
      return <div data-testid="spark" />;
    });
    render(<Impl data={[1, 2]} flowlet={{ dispatch }} __nodeId="n1" />);
    expect((seen as { flowlet?: { dispatch: unknown } })?.flowlet?.dispatch).toBe(dispatch);
    expect((seen as { nodeId?: string })?.nodeId).toBe("n1");
  });
});

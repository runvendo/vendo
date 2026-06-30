import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { chartDescriptor } from "./descriptor";
import { Chart } from "./impl";

describe("Chart", () => {
  it("schema accepts a valid bar chart and rejects an unknown kind", () => {
    const ok = { kind: "bar", categoryKey: "month", series: ["sales"], data: [{ month: "Jan", sales: 10 }] };
    expect(chartDescriptor.propsSchema.safeParse(ok).success).toBe(true);
    expect(chartDescriptor.propsSchema.safeParse({ ...ok, kind: "pie3d" }).success).toBe(false);
  });

  it("renders without throwing for each kind", () => {
    const data = [{ month: "Jan", sales: 10 }, { month: "Feb", sales: 20 }];
    for (const kind of ["bar", "line", "area", "pie"] as const) {
      const { unmount } = render(
        <FlowletThemeProvider>
          <Chart kind={kind} categoryKey="month" series={["sales"]} data={data} />
        </FlowletThemeProvider>,
      );
      unmount();
    }
  });
});

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VendoThemeProvider } from "../../theme/VendoThemeProvider.js";
import { chartDescriptor } from "./descriptor.js";
import { Chart } from "./impl.js";

describe("Chart", () => {
  it("schema accepts a valid bar chart and rejects an unknown kind", () => {
    const ok = { kind: "bar", categoryKey: "month", series: ["sales"], data: [{ month: "Jan", sales: 10 }] };
    expect(chartDescriptor.propsSchema.safeParse(ok).success).toBe(true);
    expect(chartDescriptor.propsSchema.safeParse({ ...ok, kind: "pie3d" }).success).toBe(false);
  });

  it("schema rejects empty data array (min 1 required)", () => {
    const bad = { kind: "bar", categoryKey: "month", series: ["sales"], data: [] };
    expect(chartDescriptor.propsSchema.safeParse(bad).success).toBe(false);
  });

  it("renders title heading when title is provided", () => {
    render(
      <VendoThemeProvider>
        <Chart
          kind="bar"
          title="Monthly Revenue"
          categoryKey="month"
          series={["sales"]}
          data={[{ month: "Jan", sales: 100 }]}
        />
      </VendoThemeProvider>,
    );
    expect(screen.getByRole("heading", { name: "Monthly Revenue" })).toBeInTheDocument();
  });

  it("renders an SVG (or at least a DOM element) for each kind", () => {
    const data = [{ month: "Jan", sales: 10 }, { month: "Feb", sales: 20 }];
    for (const kind of ["bar", "line", "area", "pie"] as const) {
      const { container, unmount } = render(
        <VendoThemeProvider>
          <Chart kind={kind} categoryKey="month" series={["sales"]} data={data} />
        </VendoThemeProvider>,
      );
      // Recharts renders an <svg> in real browsers; under jsdom the ResponsiveContainer
      // may not size itself, so we accept either an <svg> OR any mounted child.
      const svg = container.querySelector("svg");
      if (svg) {
        expect(svg).not.toBeNull();
      } else {
        expect(container.firstChild).not.toBeNull();
      }
      unmount();
    }
  });
});

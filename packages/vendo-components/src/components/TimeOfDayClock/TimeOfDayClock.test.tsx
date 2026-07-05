import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VendoThemeProvider } from "../../theme/VendoThemeProvider";
import { timeOfDayClockDescriptor } from "./descriptor";
import { TimeOfDayClock } from "./impl";

const renderThemed = (ui: React.ReactNode) =>
  render(<VendoThemeProvider>{ui}</VendoThemeProvider>);

describe("TimeOfDayClock", () => {
  it("schema requires points with hour + amount", () => {
    const ok = timeOfDayClockDescriptor.propsSchema.safeParse({
      points: [{ hour: 1.23, amount: 87 }],
    });
    expect(ok.success).toBe(true);
    expect(timeOfDayClockDescriptor.propsSchema.safeParse({ points: [{ hour: 1 }] }).success).toBe(false);
  });

  it("renders the highlighted charge amount and its time in the readout", () => {
    renderThemed(
      <TimeOfDayClock
        title="When you spend"
        points={[
          { hour: 9, amount: 12 },
          { hour: 1.23, amount: 87, label: "DoorDash", highlight: true },
        ]}
      />,
    );
    // Center readout shows the standout amount + label.
    expect(screen.getByText("$87")).toBeInTheDocument();
    expect(screen.getAllByText("DoorDash").length).toBeGreaterThan(0);
    // Peak-hour readout renders 1:14 AM from hour 1.23.
    expect(screen.getByText("1:14 AM")).toBeInTheDocument();
  });
});

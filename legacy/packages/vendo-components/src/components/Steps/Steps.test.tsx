import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VendoThemeProvider } from "../../theme/VendoThemeProvider.js";
import { stepsDescriptor } from "./descriptor.js";
import { Steps } from "./impl.js";

const renderThemed = (ui: React.ReactNode) =>
  render(<VendoThemeProvider>{ui}</VendoThemeProvider>);

describe("Steps", () => {
  it("schema accepts valid steps and rejects empty steps array", () => {
    expect(
      stepsDescriptor.propsSchema.safeParse({ steps: [{ text: "Do this" }] }).success,
    ).toBe(true);
    expect(stepsDescriptor.propsSchema.safeParse({ steps: [] }).success).toBe(false);
  });

  it("renders each step's text", () => {
    renderThemed(
      <Steps
        steps={[
          { title: "Install", text: "Run npm install" },
          { text: "Run npm start" },
        ]}
      />,
    );
    expect(screen.getByText("Run npm install")).toBeInTheDocument();
    expect(screen.getByText("Run npm start")).toBeInTheDocument();
    expect(screen.getByText("Install")).toBeInTheDocument();
  });
});

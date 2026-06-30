import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { stepsDescriptor } from "./descriptor";
import { Steps } from "./impl";

const renderThemed = (ui: React.ReactNode) =>
  render(<FlowletThemeProvider>{ui}</FlowletThemeProvider>);

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

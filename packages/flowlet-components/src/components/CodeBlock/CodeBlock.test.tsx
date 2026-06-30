import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { codeBlockDescriptor } from "./descriptor";
import { CodeBlock } from "./impl";

const renderThemed = (ui: React.ReactNode) =>
  render(<FlowletThemeProvider>{ui}</FlowletThemeProvider>);

describe("CodeBlock", () => {
  it("schema accepts valid code and rejects missing code", () => {
    expect(codeBlockDescriptor.propsSchema.safeParse({ code: "const x = 1;" }).success).toBe(true);
    expect(codeBlockDescriptor.propsSchema.safeParse({ code: "fn()", language: "typescript" }).success).toBe(true);
    expect(codeBlockDescriptor.propsSchema.safeParse({}).success).toBe(false);
  });

  it("renders the code text", () => {
    renderThemed(<CodeBlock code="const answer = 42;" />);
    expect(screen.getByText(/answer/)).toBeInTheDocument();
  });

  it("renders code with a language hint", () => {
    renderThemed(<CodeBlock code="print('hello')" language="python" />);
    expect(screen.getByText(/print/)).toBeInTheDocument();
  });
});

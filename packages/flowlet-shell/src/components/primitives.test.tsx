import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StreamingText } from "./StreamingText";
import { ToolCall } from "./ToolCall";

describe("StreamingText", () => {
  it("renders text and shows a caret while streaming", () => {
    const { rerender, container } = render(<StreamingText text="hello" />);
    expect(screen.getByText("hello")).toBeTruthy();
    expect(container.querySelector(".fl-caret")).toBeNull();
    rerender(<StreamingText text="hello" streaming />);
    expect(container.querySelector(".fl-caret")).not.toBeNull();
  });
});

describe("ToolCall", () => {
  it("renders the tool name and state", () => {
    render(<ToolCall toolName="budgetCreate" state="output-available" />);
    expect(screen.getByText(/budgetCreate/)).toBeTruthy();
    expect(screen.getByText(/output-available/)).toBeTruthy();
  });
});

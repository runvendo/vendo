import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SuggestionChips } from "./SuggestionChips";
import { Landing } from "./Landing";

describe("SuggestionChips", () => {
  it("calls onSelect with the chip text", () => {
    const onSelect = vi.fn();
    render(<SuggestionChips suggestions={["Show my spending"]} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Show my spending"));
    expect(onSelect).toHaveBeenCalledWith("Show my spending");
  });
});

describe("Landing", () => {
  it("shows greeting and suggestion chips", () => {
    render(
      <Landing
        greeting="What can I build?"
        suggestions={["Set a budget"]}
        onSuggestion={() => {}}
      />,
    );
    expect(screen.getByText("What can I build?")).toBeTruthy();
    expect(screen.getByText("Set a budget")).toBeTruthy();
  });
});

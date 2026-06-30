import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SuggestionChips } from "./SuggestionChips";
import { FlowGallery } from "./FlowGallery";
import { Landing } from "./Landing";
import type { Flowlet } from "../seams/store";

const flows: Flowlet[] = [{ id: "f1", name: "Spending", node: { id: "n", kind: "generated", payload: {} }, updatedAt: 1 }];

describe("SuggestionChips", () => {
  it("calls onSelect with the chip text", () => {
    const onSelect = vi.fn();
    render(<SuggestionChips suggestions={["Show my spending"]} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Show my spending"));
    expect(onSelect).toHaveBeenCalledWith("Show my spending");
  });
});

describe("FlowGallery", () => {
  it("calls onOpen with the flow", () => {
    const onOpen = vi.fn();
    render(<FlowGallery flows={flows} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("Spending"));
    expect(onOpen).toHaveBeenCalledWith(flows[0]);
  });
});

describe("Landing", () => {
  it("shows greeting, chips, and gallery", () => {
    render(
      <Landing
        greeting="What can I build?"
        suggestions={["Set a budget"]}
        flows={flows}
        onSuggestion={() => {}}
        onOpenFlow={() => {}}
      />,
    );
    expect(screen.getByText("What can I build?")).toBeTruthy();
    expect(screen.getByText("Set a budget")).toBeTruthy();
    expect(screen.getByText("Spending")).toBeTruthy();
  });
});

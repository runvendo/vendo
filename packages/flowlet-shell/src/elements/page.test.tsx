import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createStubAgent } from "@flowlet/core/testing";
import { FlowletPage } from "./FlowletPage";

function setup() {
  return render(
    <FlowletPage agent={createStubAgent()} components={[]} greeting="What do you want to build?" />,
  );
}

describe("FlowletPage", () => {
  it("opens with one tab and adds a new tab", () => {
    setup();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("New tab"));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("shows the greeting in the active empty tab", () => {
    setup();
    expect(screen.getByText("What do you want to build?")).toBeTruthy();
  });
});

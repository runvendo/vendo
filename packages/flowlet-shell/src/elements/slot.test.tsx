import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStubAgent, type UINode } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import { FlowletSlot } from "./FlowletSlot";

const node: UINode = { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} };

describe("FlowletSlot", () => {
  it("shows the empty state and opens design mode on click", async () => {
    render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider>
          <FlowletSlot flowletId="slot-1" emptyLabel="Design a flowlet here" />
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    fireEvent.click(screen.getByText("Design a flowlet here"));
    await waitFor(() => screen.getByRole("dialog"));
  });

  it("renders a saved node when one is provided", () => {
    render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider renderNode={() => <div data-testid="rendered" />}>
          <FlowletSlot flowletId="slot-1" savedNode={node} />
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    expect(screen.getByTestId("rendered")).toBeTruthy();
  });
});

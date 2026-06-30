import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStubAgent } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import { FlowletOverlay } from "./FlowletOverlay";

function setup() {
  return render(
    <FlowletProvider agent={createStubAgent()} components={[]}>
      <FlowletShellProvider>
        <FlowletOverlay launcherLabel="Ask Maple" />
      </FlowletShellProvider>
    </FlowletProvider>,
  );
}

describe("FlowletOverlay", () => {
  it("opens from the launcher and closes on Escape", async () => {
    setup();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("Ask Maple"));
    await waitFor(() => screen.getByRole("dialog"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStubAgent } from "@flowlet/core/testing";
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
  it("is invisible until summoned with Cmd/Ctrl+K, then closes on Escape", async () => {
    setup();
    // No persistent launcher — invisible until summoned.
    expect(screen.queryByText("Ask Maple")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => screen.getByRole("dialog"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

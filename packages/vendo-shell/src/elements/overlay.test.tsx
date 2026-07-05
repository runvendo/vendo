import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStubAgent } from "@vendoai/core/testing";
import { VendoProvider } from "@vendoai/react";
import { VendoShellProvider } from "../context";
import { VendoOverlay } from "./VendoOverlay";

function setup() {
  return render(
    <VendoProvider agent={createStubAgent()} components={[]}>
      <VendoShellProvider>
        <VendoOverlay launcherLabel="Ask Maple" />
      </VendoShellProvider>
    </VendoProvider>,
  );
}

describe("VendoOverlay", () => {
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

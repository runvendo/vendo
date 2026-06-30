import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createStubAgent } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider, useShell } from "./context";

function Probe() {
  const shell = useShell();
  return <div data-testid="probe">{[typeof shell.store.list, typeof shell.integrations.list, typeof shell.renderNode].join(",")}</div>;
}

describe("FlowletShellProvider", () => {
  it("provides store, integrations, and renderNode defaults", () => {
    render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider>
          <Probe />
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("function,function,function");
  });

  it("applies the flowlet-root class", () => {
    const { container } = render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider>
          <span>hi</span>
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    expect(container.querySelector(".flowlet-root")).not.toBeNull();
  });
});

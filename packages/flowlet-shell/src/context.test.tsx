import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createStubAgent } from "@flowlet/core/testing";
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

  it("applies cssVars inline on the flowlet-root element (so brand vars win over styles.css)", () => {
    const { container } = render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider cssVars={{ "--flowlet-accent": "#123456" }}>
          <span>hi</span>
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    const root = container.querySelector<HTMLElement>(".flowlet-root");
    expect(root).not.toBeNull();
    expect(root!.style.getPropertyValue("--flowlet-accent")).toBe("#123456");
  });
});

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createStubAgent } from "@vendoai/core/testing";
import { VendoProvider } from "@vendoai/react";
import { VendoShellProvider, useShell } from "./context";

function Probe() {
  const shell = useShell();
  return <div data-testid="probe">{[typeof shell.integrations.list, typeof shell.renderNode].join(",")}</div>;
}

function Probe2({ onRead }: { onRead: (v: unknown) => void }) {
  onRead(useShell());
  return null;
}

describe("VendoShellProvider", () => {
  it("provides integrations and renderNode defaults", () => {
    render(
      <VendoProvider agent={createStubAgent()} components={[]}>
        <VendoShellProvider>
          <Probe />
        </VendoShellProvider>
      </VendoProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("function,function");
  });

  it("applies the vendo-root class", () => {
    const { container } = render(
      <VendoProvider agent={createStubAgent()} components={[]}>
        <VendoShellProvider>
          <span>hi</span>
        </VendoShellProvider>
      </VendoProvider>,
    );
    expect(container.querySelector(".vendo-root")).not.toBeNull();
  });

  it("applies cssVars inline on the vendo-root element (so brand vars win over styles.css)", () => {
    const { container } = render(
      <VendoProvider agent={createStubAgent()} components={[]}>
        <VendoShellProvider cssVars={{ "--vendo-accent": "#123456" }}>
          <span>hi</span>
        </VendoShellProvider>
      </VendoProvider>,
    );
    const root = container.querySelector<HTMLElement>(".vendo-root");
    expect(root).not.toBeNull();
    expect(root!.style.getPropertyValue("--vendo-accent")).toBe("#123456");
  });
});

describe("ShellContextValue — trust seam (ENG-193 §3 Moment 12)", () => {
  it("passes `trust` through untouched, defaulting to undefined", () => {
    let seen: { trust?: unknown } | undefined;
    render(
      <VendoProvider agent={createStubAgent()} components={[]}>
        <VendoShellProvider>
          <Probe2 onRead={(v) => { seen = v as { trust?: unknown }; }} />
        </VendoShellProvider>
      </VendoProvider>,
    );
    expect(seen?.trust).toBeUndefined();
  });

  it("passes a supplied `trust` object through", () => {
    const trust = {
      listGrants: async () => [], revokeGrant: async () => {}, queryAudit: async () => [],
      listCriticalTools: async () => [], resolveFadeProposal: async () => {},
      // ENG-193 item 6 — the rules half of the seam rides through the same way.
      listRules: async () => [], revokeRule: async () => {},
    };
    let seen: { trust?: unknown } | undefined;
    render(
      <VendoProvider agent={createStubAgent()} components={[]}>
        <VendoShellProvider trust={trust}>
          <Probe2 onRead={(v) => { seen = v as { trust?: unknown }; }} />
        </VendoShellProvider>
      </VendoProvider>,
    );
    expect(seen?.trust).toBe(trust);
  });
});

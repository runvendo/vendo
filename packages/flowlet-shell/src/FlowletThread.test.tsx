import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createStubAgent } from "@flowlet/core/testing";
import { z } from "zod";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "./context";
import { FlowletThread } from "./FlowletThread";

function DemoCard({ title }: { title: string }) {
  return <div data-testid="demo-card">{title}</div>;
}

describe("FlowletThread composer placement", () => {
  const mount = (heroComposer: boolean) =>
    render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider>
          <FlowletThread heroComposer={heroComposer} />
        </FlowletShellProvider>
      </FlowletProvider>,
    );

  it("keeps the composer at the bottom by default (overlay/slot surfaces unchanged)", () => {
    const { container } = mount(false);
    expect(container.querySelector(".fl-landing .fl-composer")).toBeNull();
    expect(container.querySelector(".fl-thread > .fl-composer, .fl-thread .fl-composer")).not.toBeNull();
  });

  it("hoists the composer into the Landing hero only when heroComposer is set", () => {
    const { container } = mount(true);
    expect(container.querySelector(".fl-landing .fl-composer")).not.toBeNull();
    // exactly one composer — not duplicated at the bottom
    expect(container.querySelectorAll(".fl-composer")).toHaveLength(1);
  });
});

describe("FlowletThread end-to-end", () => {
  it("send -> approval -> approve -> renders the node", async () => {
    render(
      <FlowletProvider
        agent={createStubAgent()}
        components={[{ name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" }]}
      >
        <FlowletShellProvider impls={{ DemoCard: DemoCard as never }}>
          <FlowletThread suggestions={["show me a card"]} />
        </FlowletShellProvider>
      </FlowletProvider>,
    );

    fireEvent.click(screen.getByText("show me a card")); // suggestion chip sends
    await waitFor(() => screen.getByText("Approve"));
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => screen.getByTestId("demo-card"));
    expect(screen.getByTestId("demo-card").textContent).toBe("Hello from Flowlet");
  });
});

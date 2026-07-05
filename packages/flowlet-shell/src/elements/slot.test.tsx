import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { z } from "zod";
import { type UINode } from "@flowlet/core";
import { createStubAgent } from "@flowlet/core/testing";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import { FlowletSlot } from "./FlowletSlot";

const node: UINode = { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} };

function DemoCard({ title }: { title: string }) {
  return <div data-testid="demo-card">{title}</div>;
}

function renderSlot(props: Partial<React.ComponentProps<typeof FlowletSlot>> = {}) {
  return render(
    <FlowletProvider
      agent={createStubAgent()}
      components={[{ name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" }]}
    >
      <FlowletShellProvider impls={{ DemoCard: DemoCard as never }}>
        <FlowletSlot flowletId="slot-1" emptyLabel="Design a flowlet here" {...props} />
      </FlowletShellProvider>
    </FlowletProvider>,
  );
}

describe("FlowletSlot", () => {
  beforeEach(() => window.localStorage.clear());

  it("shows the empty state and opens design mode on click", async () => {
    renderSlot();
    fireEvent.click(screen.getByText("Design a flowlet here"));
    await waitFor(() => screen.getByRole("dialog"));
  });

  it("brands the default greeting with the host's productName", async () => {
    render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider impls={{}} productName="Acme">
          <FlowletSlot flowletId="slot-brand" emptyLabel="Design here" />
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    fireEvent.click(screen.getByText("Design here"));
    await waitFor(() => screen.getByText("What can Acme build here?"));
  });

  it("stays brand-neutral when no productName is provided", async () => {
    renderSlot();
    fireEvent.click(screen.getByText("Design a flowlet here"));
    await waitFor(() => screen.getByText("What can I build here?"));
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

  it("pins the generated view into the card, persists it, then removes it", async () => {
    renderSlot();
    fireEvent.click(screen.getByText("Design a flowlet here"));

    // Pin is disabled until a view has been rendered.
    const pinBtn = screen.getByText("Pin to card").closest("button") as HTMLButtonElement;
    expect(pinBtn.disabled).toBe(true);

    // Drive the stub agent to render a node.
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "show me a card" } });
    fireEvent.click(screen.getByLabelText("Send"));
    await waitFor(() => screen.getByText("Send it"));
    fireEvent.click(screen.getByText("Send it"));
    await waitFor(() => screen.getByTestId("demo-card"));

    // Pin the latest view -> overlay closes, card shows the view.
    fireEvent.click(screen.getByText("Pin to card"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("demo-card")).toBeTruthy();
    expect(window.localStorage.getItem("flowlet-slot:slot-1")).toContain("DemoCard");

    // Remove via the overflow menu -> back to the empty state.
    fireEvent.click(screen.getByLabelText("Flowlet options"));
    fireEvent.click(screen.getByText("Remove"));
    await waitFor(() => screen.getByText("Design a flowlet here"));
    expect(window.localStorage.getItem("flowlet-slot:slot-1")).toBeNull();
  });

  it("restores a pinned view from localStorage on mount", async () => {
    window.localStorage.setItem("flowlet-slot:slot-1", JSON.stringify(node));
    render(
      <FlowletProvider agent={createStubAgent()} components={[]}>
        <FlowletShellProvider renderNode={() => <div data-testid="rendered" />}>
          <FlowletSlot flowletId="slot-1" />
        </FlowletShellProvider>
      </FlowletProvider>,
    );
    await waitFor(() => screen.getByTestId("rendered"));
  });
});

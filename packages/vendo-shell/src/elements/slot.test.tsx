import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { z } from "zod";
import { type UINode } from "@vendoai/core";
import { createStubAgent } from "@vendoai/core/testing";
import { VendoProvider } from "@vendoai/react";
import { VendoShellProvider } from "../context";
import { VendoSlot } from "./VendoSlot";

const node: UINode = { id: "ui-1", kind: "component", source: "prewired", name: "Card", props: {} };

function DemoCard({ title }: { title: string }) {
  return <div data-testid="demo-card">{title}</div>;
}

function renderSlot(props: Partial<React.ComponentProps<typeof VendoSlot>> = {}) {
  return render(
    <VendoProvider
      agent={createStubAgent()}
      components={[{ name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" }]}
    >
      <VendoShellProvider impls={{ DemoCard: DemoCard as never }}>
        <VendoSlot vendoId="slot-1" emptyLabel="Design a vendo here" {...props} />
      </VendoShellProvider>
    </VendoProvider>,
  );
}

describe("VendoSlot", () => {
  beforeEach(() => window.localStorage.clear());

  it("shows the empty state and opens design mode on click", async () => {
    renderSlot();
    fireEvent.click(screen.getByText("Design a vendo here"));
    await waitFor(() => screen.getByRole("dialog"));
  });

  it("brands the default greeting with the host's productName", async () => {
    render(
      <VendoProvider agent={createStubAgent()} components={[]}>
        <VendoShellProvider impls={{}} productName="Acme">
          <VendoSlot vendoId="slot-brand" emptyLabel="Design here" />
        </VendoShellProvider>
      </VendoProvider>,
    );
    fireEvent.click(screen.getByText("Design here"));
    await waitFor(() => screen.getByText("What can Acme build here?"));
  });

  it("stays brand-neutral when no productName is provided", async () => {
    renderSlot();
    fireEvent.click(screen.getByText("Design a vendo here"));
    await waitFor(() => screen.getByText("What can I build here?"));
  });

  it("renders a saved node when one is provided", () => {
    render(
      <VendoProvider agent={createStubAgent()} components={[]}>
        <VendoShellProvider renderNode={() => <div data-testid="rendered" />}>
          <VendoSlot vendoId="slot-1" savedNode={node} />
        </VendoShellProvider>
      </VendoProvider>,
    );
    expect(screen.getByTestId("rendered")).toBeTruthy();
  });

  it("pins the generated view into the card, persists it, then removes it", async () => {
    renderSlot();
    fireEvent.click(screen.getByText("Design a vendo here"));

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
    expect(window.localStorage.getItem("vendo-slot:slot-1")).toContain("DemoCard");

    // Remove via the overflow menu -> back to the empty state.
    fireEvent.click(screen.getByLabelText("Vendo options"));
    fireEvent.click(screen.getByText("Remove"));
    await waitFor(() => screen.getByText("Design a vendo here"));
    expect(window.localStorage.getItem("vendo-slot:slot-1")).toBeNull();
  });

  it("restores a pinned view from localStorage on mount", async () => {
    window.localStorage.setItem("vendo-slot:slot-1", JSON.stringify(node));
    render(
      <VendoProvider agent={createStubAgent()} components={[]}>
        <VendoShellProvider renderNode={() => <div data-testid="rendered" />}>
          <VendoSlot vendoId="slot-1" />
        </VendoShellProvider>
      </VendoProvider>,
    );
    await waitFor(() => screen.getByTestId("rendered"));
  });
});

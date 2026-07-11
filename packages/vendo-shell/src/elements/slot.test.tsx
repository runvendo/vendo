import { describe, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { z } from "zod";
import { createStubAgent } from "@vendoai/core/testing";
import { VendoProvider } from "@vendoai/react";
import { VendoShellProvider } from "../context";
import { VendoSlot } from "./VendoSlot";

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

});

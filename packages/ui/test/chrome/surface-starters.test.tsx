// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoSurface } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("surface-aware overlay starters", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    window.localStorage.clear();
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    await wire.close();
  });

  const posts = () => wire.requests.filter(request => request.method === "POST" && request.path === "/threads");
  const dialog = () => screen.getByRole("dialog", { name: "Vendo assistant" });

  it("shows at most three host starters and pre-fills without sending", async () => {
    render(
      <VendoProvider client={client}>
        <VendoSurface label="Client: Acme Holdings" starters={["Build a readiness workspace", "Plan this week", "Create a document chase", "Do not show"]}>
          <VendoOverlay defaultOpen />
        </VendoSurface>
      </VendoProvider>,
    );

    expect(await screen.findByText("Client: Acme Holdings")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build a readiness workspace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Plan this week" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create a document chase" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Do not show" })).toBeNull();
    expect(screen.queryByRole("button", { name: "What can you do here?" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Build a readiness workspace" }));
    const composer = within(dialog()).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(composer.value).toBe("Build a readiness workspace");
    await waitFor(() => {
      expect(composer.selectionStart).toBe(composer.value.length);
      expect(composer.selectionEnd).toBe(composer.value.length);
    });
    expect(posts()).toHaveLength(0);
  });

  it("updates empty-state starters without resetting an existing composer draft", async () => {
    const view = (label: string, starter: string) => (
      <VendoProvider client={client}>
        <VendoSurface label={label} starters={[starter]}>
          <VendoOverlay defaultOpen />
        </VendoSurface>
      </VendoProvider>
    );
    const { rerender } = render(view("Client: Acme Holdings", "Review Acme invoices"));

    expect(await screen.findByRole("button", { name: "Review Acme invoices" })).toBeTruthy();
    const composer = within(dialog()).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Keep this draft" } });

    rerender(view("Client: Beacon Labs", "Review Beacon invoices"));

    await waitFor(() => expect(screen.getByRole("button", { name: "Review Beacon invoices" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Review Acme invoices" })).toBeNull();
    expect((within(dialog()).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(posts()).toHaveLength(0);
  });

  it("keeps the generic greeting when no surface is mounted", async () => {
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    expect(await screen.findByRole("button", { name: "What can you do here?" })).toBeTruthy();
  });
});

// @vitest-environment jsdom
// VendoTrigger — the shelf's "do it with AI" button (ui-usage-dx §2): opens
// the chat preloaded with a prompt (+ optional context). Hosts wanting a fully
// custom element skip the component and call openVendoConversation directly —
// the repo's existing programmatic-seam idiom (no render-prop API, §4).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoTrigger } from "../../src/chrome/index.js";
import { registerConversationOpener } from "../../src/chrome/overlay-open.js";
import { createWireServer } from "../wire-server.js";

describe("VendoTrigger", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;
  let opener: ReturnType<typeof vi.fn>;
  let unregister: () => void;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
    opener = vi.fn();
    unregister = registerConversationOpener(opener);
  });

  afterEach(async () => {
    unregister();
    cleanup();
    await wire.close();
  });

  const mount = (element: React.ReactElement) =>
    render(<VendoProvider client={client}>{element}</VendoProvider>);

  it("renders a native button with the given label and opens the conversation with its prompt", () => {
    mount(<VendoTrigger prompt="Chase clients with missing documents">Nudge with AI</VendoTrigger>);
    const button = screen.getByRole("button", { name: "Nudge with AI" });
    // Keyboard accessible + form-safe by construction: a real button that never submits.
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(opener).toHaveBeenCalledWith("Chase clients with missing documents");
  });

  it("appends the optional context to the prompt", () => {
    mount(
      <VendoTrigger prompt="Draft a reminder" context="Client: Acme — W-9 outstanding since June">
        Nudge with AI
      </VendoTrigger>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Nudge with AI" }));
    expect(opener).toHaveBeenCalledWith("Draft a reminder\n\nClient: Acme — W-9 outstanding since June");
  });

  it("falls back to a default label without children", () => {
    mount(<VendoTrigger prompt="Do something" />);
    expect(screen.getByRole("button", { name: "Ask Vendo" })).toBeTruthy();
  });
});

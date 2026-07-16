// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoThread } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("VendoThread and VendoOverlay exports", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    await wire.close();
  });

  // A full streaming wire turn + gated reply + approval round-trip; CI runs the
  // whole workspace's suites in parallel, so this heavy integration test can
  // starve past the 5s default under load (275ms locally, ~7s on a loaded runner).
  it("runs a complete wire turn, renders receipts and approvals, and honors composer keys", { timeout: 20_000 }, async () => {
    let release = () => undefined;
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    expect(await screen.findByText("Existing thread")).toBeTruthy();

    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "Send the email" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(wire.requests.filter(request => request.method === "POST" && request.path === "/threads")).toHaveLength(0);
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy());
    // ENG-215 — typing is never blocked mid-turn (the composer stays enabled so
    // it can queue a follow-up and never dumps focus to <body>).
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).disabled).toBe(false);
    await act(async () => release());
    // ENG-216 — the chip shows the humanized fallback label, not the raw slug
    // or a lifecycle string; the risk still rides the container's data attr.
    // Scope to the chip label class — the approval title also reads "Email send".
    const receipt = await screen.findByText("Email send", { selector: ".fl-tool-label" });
    expect(receipt.parentElement?.getAttribute("data-vendo-approval")).toBe("write");
    const card = await screen.findByLabelText("Approval for Email send");
    expect(card.textContent).toContain("a@example.com");
    expect(card.textContent).toContain(
      "This tool changed since you approved it on Jul 1, 2026 — your previous permission no longer applies.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Turn complete")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    expect(wire.requests.find(request => request.method === "POST" && request.path === "/threads")?.body).toMatchObject({
      threadId: "thr_1",
      message: { role: "user", parts: [{ type: "text", text: "Send the email" }] },
    });
  });

  it("opens as a modal, traps focus, closes on Escape, and restores launcher focus", async () => {
    render(<VendoProvider client={client}><VendoOverlay /></VendoProvider>);
    const launcher = screen.getByRole("button", { name: "Vendo" });
    launcher.focus();
    fireEvent.click(launcher);
    const dialog = screen.getByRole("dialog", { name: "Vendo assistant" });
    const close = await screen.findByRole("button", { name: "Close Vendo" });
    // ENG-220: initial focus lands in the composer, not on the close button.
    const textarea = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(launcher.getAttribute("aria-expanded")).toBe("true");

    // Tab from the last focusable (the composer) wraps to the first — the
    // new-conversation header button (ENG-221), which precedes the close X.
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New conversation" }));
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(textarea);
    expect(close).toBeTruthy(); // still present, after the new-conversation affordance

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(launcher));
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
  });
});

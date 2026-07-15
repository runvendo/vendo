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
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).disabled).toBe(true);
    await act(async () => release());
    const receipt = await screen.findByText("Tool: host_email_send");
    expect(receipt.parentElement?.getAttribute("data-vendo-approval")).toBe("write");
    const card = await screen.findByLabelText("Approval for host_email_send");
    expect(card.textContent).toContain("a@example.com");
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
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(launcher.getAttribute("aria-expanded")).toBe("true");

    const textarea = screen.getByRole("textbox", { name: "Message" });
    textarea.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(textarea);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(launcher));
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
  });
});

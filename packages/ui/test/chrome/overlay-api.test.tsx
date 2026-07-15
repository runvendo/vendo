// @vitest-environment jsdom
// ENG-220 — the supported overlay entry API: programmatic open/close
// (controlled + uncontrolled + hook), portal to document.body, body
// scroll-lock + inert background with cleanup, and focus correctness.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, useVendoOverlay, type VendoClient } from "../../src/index.js";
import { VendoOverlay } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("VendoOverlay supported entry API", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    await wire.close();
  });

  const dialogQuery = () => screen.queryByRole("dialog", { name: "Vendo assistant" });

  /** Type into the visible composer and send; waits for the streamed reply
   *  ("Turn complete" — `turns` counts completed replies across the session). */
  const sendMessage = async (text: string, turns = 1) => {
    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: text } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(screen.getAllByText("Turn complete")).toHaveLength(turns));
  };

  it("opens uncontrolled via defaultOpen and positions the default launcher", () => {
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    expect(dialogQuery()).toBeTruthy();
    const launcher = screen.getByRole("button", { name: "Vendo" });
    expect(launcher.getAttribute("data-vendo-launcher")).toBe("bottom-right");
  });

  it("supports bottom-left and hidden launcher variants", () => {
    const { rerender } = render(<VendoProvider client={client}><VendoOverlay launcher="bottom-left" /></VendoProvider>);
    expect(screen.getByRole("button", { name: "Vendo" }).getAttribute("data-vendo-launcher")).toBe("bottom-left");
    rerender(<VendoProvider client={client}><VendoOverlay launcher="none" /></VendoProvider>);
    expect(screen.queryByRole("button", { name: "Vendo" })).toBeNull();
  });

  it("is controllable: open renders, close requests report via onOpenChange, parent flip closes", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <VendoProvider client={client}><VendoOverlay open onOpenChange={onOpenChange} /></VendoProvider>,
    );
    const dialog = dialogQuery();
    expect(dialog).toBeTruthy();

    // Escape asks the controller to close but does NOT self-close.
    fireEvent.keyDown(dialog!, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(dialogQuery()).toBeTruthy();

    rerender(<VendoProvider client={client}><VendoOverlay open={false} onOpenChange={onOpenChange} /></VendoProvider>);
    expect(dialogQuery()).toBeNull();
  });

  it("closes on scrim click (full click, so the press cannot fall through to the page)", () => {
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    expect(dialogQuery()).toBeTruthy();
    const scrim = document.querySelector(".fl-overlay-scrim")!;
    fireEvent.mouseDown(scrim);
    expect(dialogQuery()).toBeTruthy(); // mousedown alone must NOT dismiss
    fireEvent.click(scrim);
    expect(dialogQuery()).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("drives open/close through the useVendoOverlay hook", async () => {
    function Host() {
      const overlay = useVendoOverlay();
      return (
        <>
          <button type="button" onClick={overlay.toggle}>host-k</button>
          <VendoOverlay {...overlay.overlayProps} launcher="none" />
        </>
      );
    }
    render(<VendoProvider client={client}><Host /></VendoProvider>);
    expect(dialogQuery()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "host-k" }));
    expect(dialogQuery()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "host-k" }));
    expect(dialogQuery()).toBeNull();
  });

  it("portals the panel to document.body, outside the host container", () => {
    const { container } = render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    const dialog = dialogQuery()!;
    expect(container.contains(dialog)).toBe(false);
    const wrapper = dialog.closest(".fl-overlay-portal")!;
    expect(wrapper.parentElement).toBe(document.body);
    // The wrapper carries the theme bridge so the panel stays brand-native.
    expect(wrapper.className).toContain("vendo-root");
  });

  it("locks body scroll and inerts the background while open, and cleans both up on close", async () => {
    const { container } = render(<VendoProvider client={client}><VendoOverlay /></VendoProvider>);
    const host = container; // RTL mount div, a direct body child
    expect(document.body.style.overflow).toBe("");
    expect(host.hasAttribute("inert")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Vendo" }));
    expect(document.body.style.overflow).toBe("hidden");
    expect(host.hasAttribute("inert")).toBe(true);
    // The portal subtree itself must stay interactive.
    expect(dialogQuery()!.closest("[inert]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close Vendo" }));
    expect(document.body.style.overflow).toBe("");
    expect(host.hasAttribute("inert")).toBe(false);
  });

  it("cleans up scroll-lock and inert when unmounted while open", () => {
    const { container, unmount } = render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    const host = container;
    expect(document.body.style.overflow).toBe("hidden");
    expect(host.hasAttribute("inert")).toBe(true);
    unmount();
    expect(document.body.style.overflow).toBe("");
    expect(host.hasAttribute("inert")).toBe(false);
  });

  it("autofocuses the composer on open", async () => {
    render(<VendoProvider client={client}><VendoOverlay /></VendoProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Vendo" }));
    const composer = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(document.activeElement).toBe(composer));
  });

  it("restores focus to the invoking element on close even with no visible launcher", async () => {
    function Host() {
      const overlay = useVendoOverlay();
      return (
        <>
          <button type="button" onClick={overlay.toggle}>host-k</button>
          <VendoOverlay {...overlay.overlayProps} launcher="none" />
        </>
      );
    }
    render(<VendoProvider client={client}><Host /></VendoProvider>);
    const invoker = screen.getByRole("button", { name: "host-k" });
    invoker.focus();
    fireEvent.click(invoker);
    const composer = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(document.activeElement).toBe(composer));

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Vendo assistant" }), { key: "Escape" });
    // Never dumped on <body>: focus returns to the element that opened it.
    await waitFor(() => expect(document.activeElement).toBe(invoker));
  });

  it("keeps the conversation across close/reopen instead of discarding it (ENG-221)", async () => {
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    await sendMessage("remember me");
    expect(screen.getByText("remember me")).toBeTruthy();

    // Scrim click hides the overlay — it must NOT destroy the thread state.
    fireEvent.click(document.querySelector(".fl-overlay-scrim")!);
    expect(dialogQuery()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Vendo" }));
    expect(dialogQuery()).toBeTruthy();
    // The prior conversation is right where the user left it.
    expect(screen.getByText("remember me")).toBeTruthy();
    expect(screen.getByText("Turn complete")).toBeTruthy();

    // And the next turn continues the SAME server thread (adopted thr_ id).
    await sendMessage("still you?", 2);
    const posts = wire.requests.filter(r => r.method === "POST" && r.path === "/threads");
    expect(posts).toHaveLength(2);
    expect((posts[1]!.body as { threadId?: string }).threadId).toBe("thr_minted");
  });

  it("preserves the conversation across an Escape close too", async () => {
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    await sendMessage("via escape");

    fireEvent.keyDown(dialogQuery()!, { key: "Escape" });
    expect(dialogQuery()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Vendo" }));
    expect(screen.getByText("via escape")).toBeTruthy();
    expect(screen.getByText("Turn complete")).toBeTruthy();
  });

  it("starts a fresh thread via the new-conversation affordance", async () => {
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    await sendMessage("old thread");

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    // Back to the empty landing: prior messages are gone…
    expect(screen.queryByText("old thread")).toBeNull();
    expect(screen.getByText("What can I help you build?")).toBeTruthy();

    // …and the next send does NOT carry the old threadId (server mints a new one).
    await sendMessage("brand new");
    const posts = wire.requests.filter(r => r.method === "POST" && r.path === "/threads");
    expect(posts).toHaveLength(2);
    expect((posts[1]!.body as { threadId?: string }).threadId).toBeUndefined();
  });

  it("exposes newConversation through the useVendoOverlay hook (headless parity)", async () => {
    function Host() {
      const overlay = useVendoOverlay({ defaultOpen: true });
      return (
        <>
          <button type="button" onClick={overlay.newConversation}>host-new</button>
          <VendoOverlay {...overlay.overlayProps} launcher="none" />
        </>
      );
    }
    render(<VendoProvider client={client}><Host /></VendoProvider>);
    await sendMessage("hook thread");

    fireEvent.click(screen.getByRole("button", { name: "host-new" }));
    expect(screen.queryByText("hook thread")).toBeNull();
    expect(screen.getByText("What can I help you build?")).toBeTruthy();

    await sendMessage("hook fresh");
    const posts = wire.requests.filter(r => r.method === "POST" && r.path === "/threads");
    expect(posts).toHaveLength(2);
    expect((posts[1]!.body as { threadId?: string }).threadId).toBeUndefined();
  });

  it("skips a display:none restore target instead of swallowing focus", async () => {
    function Host() {
      const overlay = useVendoOverlay();
      return (
        <>
          <button type="button" style={{ display: "none" }} onClick={overlay.toggle}>hidden-invoker</button>
          <button type="button" onClick={overlay.toggle}>visible-invoker</button>
          <VendoOverlay {...overlay.overlayProps} />
        </>
      );
    }
    render(<VendoProvider client={client}><Host /></VendoProvider>);
    const hidden = screen.getByText("hidden-invoker");
    const visible = screen.getByRole("button", { name: "visible-invoker" });
    visible.focus();
    fireEvent.click(hidden); // opens; the recorded invoker is the visible-focused element
    const composer = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(document.activeElement).toBe(composer));

    // Hide the invoker while the overlay is open — restore must skip it and
    // fall back to the (visible) launcher rather than dropping focus on body.
    visible.style.display = "none";
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Vendo assistant" }), { key: "Escape" });
    const launcher = screen.getByRole("button", { name: "Vendo" });
    await waitFor(() => expect(document.activeElement).toBe(launcher));
    expect(document.activeElement).not.toBe(document.body);
  });
});

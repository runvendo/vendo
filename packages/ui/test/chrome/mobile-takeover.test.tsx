// @vitest-environment jsdom
// ENG-228 — the mobile takeover: the designed-but-dead `.fl-takeover` mode
// comes alive. useMobileTakeover (matchMedia <768px) stamps the class on the
// overlay panel and the palette; visualViewport drives a
// --fl-kb-inset var so the composer rides above the virtual keyboard; the
// stylesheet gains the iOS-zoom (>=16px inputs) and 44px touch-target floor
// plus a min-width floor on thread surfaces.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoPalette, VendoToasts, dismissAllVendoToasts, vendoToast } from "../../src/chrome/index.js";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";
import { inertBehind } from "../../src/chrome/inert-behind.js";
import { createWireServer } from "../wire-server.js";

const TAKEOVER_QUERY = "(max-width: 767px)";

type Listener = (event: { matches: boolean }) => void;

/** jsdom has no matchMedia: install a controllable stub. Only the takeover
 *  query is switchable; every other query (reduced-motion probes elsewhere in
 *  the chrome) stays non-matching. */
function installMatchMedia(initialMobile: boolean) {
  const listeners = new Set<Listener>();
  const state = { mobile: initialMobile };
  const stub = vi.fn((query: string) => ({
    get matches() {
      return query === TAKEOVER_QUERY ? state.mobile : false;
    },
    media: query,
    addEventListener: (_type: string, listener: Listener) => {
      if (query === TAKEOVER_QUERY) listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: Listener) => {
      listeners.delete(listener);
    },
    addListener: (listener: Listener) => {
      if (query === TAKEOVER_QUERY) listeners.add(listener);
    },
    removeListener: (listener: Listener) => {
      listeners.delete(listener);
    },
    onchange: null,
    dispatchEvent: () => false,
  }));
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: stub });
  return {
    setMobile(mobile: boolean) {
      state.mobile = mobile;
      for (const listener of [...listeners]) listener({ matches: mobile });
    },
  };
}

/** Minimal visualViewport stand-in: height/offsetTop + resize/scroll events. */
function installVisualViewport(height: number) {
  const listeners = new Map<string, Set<() => void>>();
  const viewport = {
    height,
    offsetTop: 0,
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    resizeTo(next: number) {
      viewport.height = next;
      for (const listener of [...(listeners.get("resize") ?? [])]) listener();
    },
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, writable: true, value: viewport });
  return viewport;
}

describe("mobile takeover (ENG-228)", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "matchMedia");
    Reflect.deleteProperty(window, "visualViewport");
    await wire.close();
  });

  const panel = () => screen.getByRole("dialog", { name: "Vendo assistant" });

  it("stamps fl-takeover on the overlay panel at the mobile breakpoint", () => {
    installMatchMedia(true);
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    expect(panel().classList.contains("fl-takeover")).toBe(true);
  });

  it("keeps the desktop overlay untouched above the breakpoint", () => {
    installMatchMedia(false);
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    expect(panel().classList.contains("fl-takeover")).toBe(false);
  });

  it("follows live breakpoint flips (rotation / resize)", async () => {
    const media = installMatchMedia(false);
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    expect(panel().classList.contains("fl-takeover")).toBe(false);
    media.setMobile(true);
    await waitFor(() => expect(panel().classList.contains("fl-takeover")).toBe(true));
    media.setMobile(false);
    await waitFor(() => expect(panel().classList.contains("fl-takeover")).toBe(false));
  });

  it("survives hosts without matchMedia (SSR-ish environments): no takeover, no crash", () => {
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    expect(panel().classList.contains("fl-takeover")).toBe(false);
  });

  // One-surface ⌘K (ui-lane-entry pick P-C): the palette no longer renders a
  // dialog — the keybinding opens the conversation overlay itself.
  it("routes ⌘K to the overlay, takeover-stamped and portaled on mobile", async () => {
    installMatchMedia(true);
    const { container } = render(
      <VendoProvider client={client}><VendoPalette /><VendoOverlay launcher="none" /></VendoProvider>,
    );
    fireEvent.keyDown(globalThis, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Vendo assistant" });
    expect(dialog.classList.contains("fl-takeover")).toBe(true);
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.closest(".fl-overlay-portal")!.parentElement).toBe(document.body);
  });

  it("routes desktop ⌘K to the overlay without the takeover stamp", async () => {
    installMatchMedia(false);
    render(
      <VendoProvider client={client}><VendoPalette /><VendoOverlay launcher="none" /></VendoProvider>,
    );
    fireEvent.keyDown(globalThis, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Vendo assistant" });
    expect(dialog.classList.contains("fl-takeover")).toBe(false);
  });

  it("wires the virtual keyboard inset into --fl-kb-inset and tracks visualViewport resizes", async () => {
    installMatchMedia(true);
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 844 });
    const viewport = installVisualViewport(844);
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    expect(panel().style.getPropertyValue("--fl-kb-inset")).toBe("0px");

    viewport.resizeTo(500); // keyboard opens: 844 - 500 = 344px covered
    await waitFor(() => expect(panel().style.getPropertyValue("--fl-kb-inset")).toBe("344px"));

    viewport.resizeTo(844); // keyboard closes
    await waitFor(() => expect(panel().style.getPropertyValue("--fl-kb-inset")).toBe("0px"));
  });

  it("inerts body children that mount while the overlay is open (late takeover portals)", async () => {
    installMatchMedia(true);
    const { unmount } = render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    expect(panel()).toBeTruthy();
    // A body child appearing AFTER the overlay opened — a host toast portal,
    // say. The open-time snapshot alone would leave it interactive behind the
    // modal scrim.
    const late = document.createElement("div");
    document.body.appendChild(late);
    await waitFor(() => expect(late.hasAttribute("inert")).toBe(true));
    unmount();
    expect(late.hasAttribute("inert")).toBe(false);
    late.remove();
  });

  it("⌘K toggles an already-open overlay closed (one surface, no second modal)", async () => {
    installMatchMedia(true);
    render(
      <VendoProvider client={client}>
        <VendoOverlay defaultOpen />
        <VendoPalette />
      </VendoProvider>,
    );
    expect(panel()).toBeTruthy();
    fireEvent.keyDown(globalThis, { key: "k", ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull());
    // No palette dialog ever mounts — the keybinding owns ONE surface.
    expect(screen.queryByRole("dialog", { name: "Vendo command palette" })).toBeNull();
    fireEvent.keyDown(globalThis, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Vendo assistant" })).toBeTruthy();
  });

  it("does not track the keyboard on desktop", () => {
    installMatchMedia(false);
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 844 });
    installVisualViewport(500);
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    expect(panel().style.getPropertyValue("--fl-kb-inset")).toBe("");
  });

  // jsdom computes no layout and applies no media queries, so the size rules
  // are asserted against the shipped stylesheet itself; the real-browser
  // check lives in docs/verification/eng-228/.
  describe("stylesheet contract", () => {
    const mobileBlock = () => {
      const match = CHROME_CSS.match(/@media \(max-width: 767px\), \(pointer: coarse\) \{([\s\S]*?)\n\}/);
      expect(match, "mobile/coarse-pointer media block present").toBeTruthy();
      return match![1]!;
    };

    it("keeps the takeover panel safe-area padded and keyboard-inset aware", () => {
      const takeoverRules = CHROME_CSS.slice(CHROME_CSS.indexOf(".fl-overlay-panel.fl-takeover"));
      expect(takeoverRules).toContain("env(safe-area-inset-top, 0px)");
      // The takeover panel lifts its bottom edge above the virtual keyboard.
      expect(takeoverRules).toContain("padding-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--fl-kb-inset, 0px))");
    });

    it("raises text inputs to >=16px on mobile/coarse pointers (iOS auto-zoom floor)", () => {
      const block = mobileBlock();
      expect(block).toMatch(/\.fl-composer textarea[^{]*\{[^}]*font-size: 16px/);
      expect(block).toMatch(/\.fl-picker-search[^{]*\{[^}]*font-size: 16px/);
    });

    it("raises icon buttons to the 44px touch-target floor on mobile/coarse pointers", () => {
      const block = mobileBlock();
      for (const selector of [".fl-icon-btn", ".fl-overlay-close"]) {
        const rule = new RegExp(`${selector.replace(/[.$*+?()[\]{}|^\\]/g, "\\$&")}[^{]*\\{[^}]*width: 44px; height: 44px`);
        expect(block, `${selector} gets 44px targets`).toMatch(rule);
      }
      // Repointed from `.fl-jump`, which this list named until the 3A pill
      // replaced that circle: the class stopped being rendered, so the rule it
      // asserted was a ghost and the floor it promised had quietly stopped
      // existing. The pill is the live jump-to-latest affordance and inherits
      // the obligation — as a TAP target only, since its rendered height is a
      // deliberate design choice (see the pseudo-element in the sheet).
      expect(block, ".fl-newbar gets a 44px tap target").toMatch(/\.fl-newbar::after[^{]*\{[^}]*height: 44px/);
    });

    it("floors the thread width so squeezed host columns stay readable", () => {
      expect(CHROME_CSS).toMatch(/\.fl-thread \{[^}]*min-width: /);
    });

    it("keeps the takeover palette above the takeover overlay surface", () => {
      // the overlay panel takes over at z 2147483001; the palette is a modal
      // over it, so its takeover scrim must sit higher.
      expect(CHROME_CSS).toMatch(/\.fl-overlay-scrim\.fl-takeover \{[^}]*z-index: 2147483002/);
    });
  });
});

/**
 * H-2 — `inertBehind` had no ownership, so two overlapping body-level surfaces
 * corrupted each other's state. The function is the whole mechanism, so it is
 * driven directly here (no mock): a real body, real elements, real attributes.
 */
describe("inertBehind ownership and the surfaces that stay above it (H-2)", () => {
  const nodes: Element[] = [];
  const bodyChild = (attrs: Record<string, string> = {}): HTMLDivElement => {
    const node = document.createElement("div");
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    document.body.appendChild(node);
    nodes.push(node);
    return node;
  };

  afterEach(() => {
    for (const node of nodes.splice(0)) node.remove();
  });

  it("a first surface's release never un-inerts the host under a SECOND one", () => {
    const host = bodyChild();
    const overlay = bodyChild();
    const takeover = bodyChild();

    const releaseOverlay = inertBehind(overlay);
    expect(host.hasAttribute("inert")).toBe(true);
    // The takeover opens on top and finds the host already inert.
    const releaseTakeover = inertBehind(takeover);
    // The overlay closes. The takeover is still covering the whole viewport.
    releaseOverlay();
    expect(host.hasAttribute("inert")).toBe(true);
    // …and only the last surface out puts the host back.
    releaseTakeover();
    expect(host.hasAttribute("inert")).toBe(false);
  });

  it("never clears an `inert` the HOST set itself", () => {
    const host = bodyChild({ inert: "" });
    const surface = bodyChild();
    inertBehind(surface)();
    expect(host.hasAttribute("inert")).toBe(true);
  });

  it("leaves the toast stack reachable — it is above the modal layer, not behind it", async () => {
    installMatchMedia(false);
    // No wire traffic: the stack is the imperative feed (`approvals` is off).
    const offline = createVendoClient({ baseUrl: "http://vendo.test" });
    render(<VendoProvider client={offline}><VendoToasts /></VendoProvider>);
    act(() => { vendoToast({ text: "Waiting on you: Send money", actions: [{ label: "Approve", onAction: () => undefined }] }); });
    const region = await screen.findByRole("region", { name: "Notifications" });
    const portal = region.closest(".vendo-root")!;
    expect(portal.parentElement).toBe(document.body);

    const surface = bodyChild();
    const release = inertBehind(surface);
    // The ask, and its Approve button, must still be reachable while a modal
    // Vendo surface is up.
    expect(region.closest("[inert]")).toBeNull();
    expect(screen.getByRole("button", { name: "Approve" }).closest("[inert]")).toBeNull();
    release();
    dismissAllVendoToasts();
  });
});

// @vitest-environment jsdom
// ENG-228 — the mobile takeover: the designed-but-dead `.fl-takeover` mode
// comes alive. useMobileTakeover (matchMedia <768px) stamps the class on the
// overlay panel, the page, and the palette; visualViewport drives a
// --fl-kb-inset var so the composer rides above the virtual keyboard; the
// stylesheet gains the iOS-zoom (>=16px inputs) and 44px touch-target floor
// plus a min-width floor on thread surfaces.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoPage, VendoPalette } from "../../src/chrome/index.js";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";
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

  it("stamps fl-takeover on the page surface and portals it over the host (transformed ancestors)", () => {
    installMatchMedia(true);
    const { container } = render(<VendoProvider client={client}><VendoPage /></VendoProvider>);
    const page = screen.getByRole("main", { name: "Vendo workspace" });
    expect(page.classList.contains("fl-takeover")).toBe(true);
    // position:fixed is captured by any transformed/filtered host ancestor
    // (page-transition animations are everywhere), so full-bleed is only real
    // when the takeover escapes to document.body — like the overlay portal.
    expect(container.contains(page)).toBe(false);
    const wrapper = page.closest(".fl-overlay-portal")!;
    expect(wrapper.parentElement).toBe(document.body);
    expect(wrapper.className).toContain("vendo-root");
  });

  it("keeps the desktop page in-tree in the host layout", () => {
    installMatchMedia(false);
    const { container } = render(<VendoProvider client={client}><VendoPage /></VendoProvider>);
    const page = screen.getByRole("main", { name: "Vendo workspace" });
    expect(page.classList.contains("fl-takeover")).toBe(false);
    expect(container.contains(page)).toBe(true);
  });

  it("stamps fl-takeover on the open palette and portals it over the host", async () => {
    installMatchMedia(true);
    const { container } = render(<VendoProvider client={client}><VendoPalette /></VendoProvider>);
    fireEvent.keyDown(globalThis, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Vendo command palette" });
    expect(dialog.classList.contains("fl-takeover")).toBe(true);
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.closest(".fl-overlay-portal")!.parentElement).toBe(document.body);
  });

  it("keeps the desktop palette in-tree", async () => {
    installMatchMedia(false);
    const { container } = render(<VendoProvider client={client}><VendoPalette /></VendoProvider>);
    fireEvent.keyDown(globalThis, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Vendo command palette" });
    expect(dialog.classList.contains("fl-takeover")).toBe(false);
    expect(container.contains(dialog)).toBe(true);
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

    it("keeps the takeover surfaces safe-area padded and keyboard-inset aware", () => {
      const takeoverRules = CHROME_CSS.slice(CHROME_CSS.indexOf(".fl-overlay-panel.fl-takeover"));
      expect(takeoverRules).toContain("env(safe-area-inset-top, 0px)");
      // Both takeover surfaces lift their bottom edge above the virtual keyboard.
      const bottoms = CHROME_CSS.match(/padding-bottom: calc\(env\(safe-area-inset-bottom, 0px\) \+ var\(--fl-kb-inset, 0px\)\)/g) ?? [];
      expect(bottoms.length).toBeGreaterThanOrEqual(2);
    });

    it("raises text inputs to >=16px on mobile/coarse pointers (iOS auto-zoom floor)", () => {
      const block = mobileBlock();
      expect(block).toMatch(/\.fl-composer textarea[^{]*\{[^}]*font-size: 16px/);
      expect(block).toMatch(/\.fl-picker-search[^{]*\{[^}]*font-size: 16px/);
    });

    it("raises icon buttons to the 44px touch-target floor on mobile/coarse pointers", () => {
      const block = mobileBlock();
      for (const selector of [".fl-icon-btn", ".fl-jump", ".fl-overlay-close"]) {
        const rule = new RegExp(`${selector.replace(/[.$*+?()[\]{}|^\\]/g, "\\$&")}[^{]*\\{[^}]*width: 44px; height: 44px`);
        expect(block, `${selector} gets 44px targets`).toMatch(rule);
      }
    });

    it("floors the thread width so squeezed host columns stay readable", () => {
      expect(CHROME_CSS).toMatch(/\.fl-thread \{[^}]*min-width: /);
    });

    it("keeps the takeover palette above takeover page/overlay surfaces", () => {
      // page + overlay panel take over at z 2147483001; the palette is a modal
      // over them, so its takeover scrim must sit higher.
      expect(CHROME_CSS).toMatch(/\.fl-overlay-scrim\.fl-takeover \{[^}]*z-index: 2147483002/);
    });
  });
});

// @vitest-environment jsdom
// Keystone graduates B8 — the pin ceremony. A pin used to be silent: the panel
// stayed open over the page and the slot showed the app whenever its next ≤5s
// poll happened to fire. Now the panel dismisses first, a ghost of the card
// flies into the slot (300ms) and the slot settles with a pulse (180ms), and
// the slot re-reads on the pin itself instead of waiting for a tick.
import type { AppDocument } from "@vendoai/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoSlot, playPinCeremony, usePinAction } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

interface Recorded {
  element: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: { onfinish: (() => void) | null };
}

let recorded: Recorded[] = [];

/** jsdom ships no Web Animations API. The stub records what the ceremony asked
 *  for (which IS the animation's contract — fixed, deterministic keyframes) and
 *  lets a test finish an animation on demand. */
function stubAnimations() {
  recorded = [];
  Element.prototype.animate = function animate(
    this: Element,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ) {
    const animation = { onfinish: null as (() => void) | null };
    recorded.push({ element: this, keyframes, options, animation });
    return animation as unknown as Animation;
  } as unknown as typeof Element.prototype.animate;
}

/** jsdom lays nothing out, so every rect is 0×0 and the ceremony would treat
 *  both ends as absent. Size the two things it measures. */
function stubRects(boxes: { selector: string; rect: Partial<DOMRect> }[]) {
  Element.prototype.getBoundingClientRect = function rect(this: Element) {
    const match = boxes.find(box => this.matches(box.selector));
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, ...match?.rect } as DOMRect;
  };
}

function flushFrames() {
  // The ceremony measures on rAF×2, so the payoff plays over the bare page.
  return new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

const flight = () => recorded.find(entry => entry.element.hasAttribute("data-vendo-pin-ghost"));
const ring = () => document.querySelector("[data-vendo-pin-ring]");
const ghost = () => document.querySelector("[data-vendo-pin-ghost]");

describe("the pin ceremony (Keystone graduates B8)", () => {
  const originalAnimate = Element.prototype.animate;
  const originalRect = Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    stubAnimations();
    stubRects([
      { selector: "[data-vendo-app-embed]", rect: { left: 400, top: 120, width: 600, height: 400 } },
      { selector: "[data-vendo-slot]", rect: { left: 40, top: 600, width: 300, height: 200 } },
    ]);
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    Element.prototype.animate = originalAnimate;
    Element.prototype.getBoundingClientRect = originalRect;
    vi.restoreAllMocks();
  });

  /** The card, inside the themed root a panel would own, plus the slot it
   *  lands in — the two ends of the flight, without a whole overlay. */
  function stage(): { panel: HTMLElement } {
    const panel = document.createElement("div");
    panel.className = "vendo-root";
    panel.style.setProperty("--vendo-accent", "#123456");
    panel.innerHTML = `<div data-vendo-app-embed="app_1">Your view</div>`;
    document.body.append(panel);
    const slot = document.createElement("div");
    slot.setAttribute("data-vendo-slot", "hero");
    document.body.append(slot);
    return { panel };
  }

  it("lifts the ghost clear of the panel, THEN dismisses, then flies to the slot", async () => {
    const { panel } = stage();
    // The load-bearing detail: the ghost's obvious parent is the card's own
    // .vendo-root, which is the panel the dismiss hides — a naive
    // close-then-fly makes the ghost vanish mid-flight.
    playPinCeremony({ appId: "app_1", slot: "hero", dismiss: () => panel.remove() });

    expect(ghost()).toBeTruthy();
    expect(panel.isConnected).toBe(false);
    const stageEl = ghost()!.parentElement!;
    expect(stageEl.getAttribute("data-vendo-pin-stage")).toBe("");
    expect(stageEl.parentElement).toBe(document.body);
    // The stage carries the panel's theme so the ghost is not rendered unthemed.
    expect(stageEl.style.getPropertyValue("--vendo-accent")).toBe("#123456");

    await flushFrames();
    expect(flight()).toBeTruthy();
  });

  it("flies to the slot's centre and settles inside the half-second budget", async () => {
    stage();
    playPinCeremony({ appId: "app_1", slot: "hero" });
    await flushFrames();

    const move = flight()!;
    // 300×200 destination from a 600×400 card: the tighter axis wins (0.5), and
    // the ghost lands centred on the slot.
    expect(move.keyframes[1]!.transform).toBe("translate(-360px, 480px) scale(0.5)");
    expect(move.options.duration).toBe(300);

    move.animation.onfinish!();
    expect(ghost()).toBeNull();
    const pulse = recorded.find(entry => entry.element.hasAttribute("data-vendo-pin-ring"))!;
    expect(pulse.options.duration).toBe(180);
    expect(ring()).toBeTruthy();
    expect(Number(move.options.duration) + Number(pulse.options.duration)).toBeLessThan(500);
  });

  it("reduced motion fades and pulses in place — nothing flies", async () => {
    stage();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    playPinCeremony({ appId: "app_1", slot: "hero" });

    expect(ghost()).toBeNull();
    await flushFrames();
    expect(flight()).toBeUndefined();
    expect(ring()).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("brings the slot on screen before measuring, so the payoff is watchable", async () => {
    stage();
    // The panel is a modal over a page the user may have scrolled away from
    // its slot; a flight to somewhere above the fold shows them nothing.
    const scrollIntoView = vi.fn();
    (document.querySelector("[data-vendo-slot]") as HTMLElement).scrollIntoView = scrollIntoView;
    playPinCeremony({ appId: "app_1", slot: "hero" });
    await flushFrames();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

  it("finds the only mounted slot when the host names none", async () => {
    stage();
    playPinCeremony({ appId: "app_1" });
    await flushFrames();
    expect(flight()).toBeTruthy();
  });

  it("dismisses and strands nothing when the destination is not mounted", async () => {
    const { panel } = stage();
    document.querySelector("[data-vendo-slot]")!.remove();
    playPinCeremony({ appId: "app_1", slot: "hero", dismiss: () => panel.remove() });

    expect(panel.isConnected).toBe(false);
    await flushFrames();
    expect(ghost()).toBeNull();
    expect(document.querySelector("[data-vendo-pin-stage]")).toBeNull();
    expect(ring()).toBeNull();
  });
});

const pinnedApp: AppDocument = {
  format: "vendo/app@1",
  id: "app_1",
  name: "Invoices",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "Invoices app surface" } }],
  },
  pins: [{ slot: "hero", base: "sha256:abc123" }],
};

describe("the slot refreshes on the pin, not on the next poll tick", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await wire.close();
  });

  function PinButton() {
    const pin = usePinAction();
    return pin ? <button type="button" onClick={() => pin({ appId: "app_1", payload: {} })}>Pin</button> : null;
  }

  it("shows the pinned app immediately instead of waiting out the 5s poll", async () => {
    const list = vi.spyOn(client.apps, "list").mockResolvedValue([]);
    const onPin = vi.fn(async () => {
      list.mockResolvedValue([pinnedApp]);
    });

    render(
      <VendoProvider client={client} onPin={onPin} pinSlot="hero">
        <VendoSlot id="hero" />
        <PinButton />
      </VendoProvider>,
    );
    await waitFor(() => expect(list).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Pin" }));

    expect(onPin).toHaveBeenCalledWith({ appId: "app_1", payload: {} });
    // The default poll is 5000ms; this has to land long before that.
    expect(await screen.findByText("Invoices app surface", undefined, { timeout: 1500 })).toBeTruthy();
  });

  it("hides the affordance when the host wired no onPin", () => {
    render(<VendoProvider client={client}><PinButton /></VendoProvider>);
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
  });
});

// @vitest-environment jsdom
// Keystone graduates B8 — the pin ceremony. A pin used to be silent: the panel
// stayed open over the page and the slot showed the app whenever its next ≤5s
// poll happened to fire. Now the panel dismisses first, a ghost of the card
// flies into the slot (300ms) and the slot settles with a pulse (180ms), and
// the slot re-reads on the pin itself instead of waiting for a tick.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoSlot, VendoToasts, playPinCeremony, usePinAction, usePinNudge } from "../../src/chrome/index.js";
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

  it("honours a host that set theme.motion: reduced, not only the OS setting", async () => {
    // `theme.motion` is a promise the HOST makes on the person's behalf, and
    // this flight only ever consulted the OS media query. The chrome
    // stylesheet's `[data-vendo-motion="reduced"] * { animation: none }` cannot
    // cover for it either: a Web Animations flight is not a CSS animation.
    const { panel } = stage();
    // Exactly what ChromeRoot writes on every chrome boundary.
    panel.setAttribute("data-vendo-motion", "reduced");
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    playPinCeremony({ appId: "app_1", slot: "hero" });

    expect(ghost()).toBeNull();
    await flushFrames();
    expect(flight()).toBeUndefined();
    // The settle pulse stays: reduced motion is not "no feedback".
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

  it("targets a <Remixable> wrapper — the fork's in-place mount boundary (2026-08-02)", async () => {
    const { panel } = stage();
    document.querySelector("[data-vendo-slot]")!.remove();
    stubRects([
      { selector: "[data-vendo-app-embed]", rect: { left: 400, top: 120, width: 600, height: 400 } },
      { selector: "[data-vendo-remixable]", rect: { left: 40, top: 600, width: 300, height: 200 } },
    ]);
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-vendo-remixable", "TopMerchants");
    document.body.append(wrapper);
    playPinCeremony({ appId: "app_1", slot: "TopMerchants", dismiss: () => panel.remove() });
    await flushFrames();
    expect(flight()).toBeTruthy();
    flight()!.animation.onfinish!();
    expect(ring()).toBeTruthy();
  });

  /** The Apps shelf, as `AppShelf` renders it live (center/home.tsx). */
  function shelf(ghost = false): HTMLElement {
    const section = document.createElement("section");
    section.className = ghost ? "fl-shelf fl-shelf--ghost" : "fl-shelf";
    section.setAttribute("aria-label", ghost ? "What you could build" : "Your apps");
    document.body.append(section);
    return section;
  }

  it("lands in the Apps shelf when no host slot resolves — the pin used to vanish", async () => {
    // The silent no-op this closes: zero slots mounted (or several and none
    // named) dismissed the panel and then played NOTHING, so the user's pin
    // disappeared. The shelf is where a pinned app shows up, so it is the floor.
    const { panel } = stage();
    document.querySelector("[data-vendo-slot]")!.remove();
    stubRects([
      { selector: "[data-vendo-app-embed]", rect: { left: 400, top: 120, width: 600, height: 400 } },
      { selector: ".fl-shelf", rect: { left: 40, top: 600, width: 300, height: 200 } },
    ]);
    shelf();
    playPinCeremony({ appId: "app_1", slot: "hero", dismiss: () => panel.remove() });

    await flushFrames();
    expect(flight()!.keyframes[1]!.transform).toBe("translate(-360px, 480px) scale(0.5)");
    flight()!.animation.onfinish!();
    expect(ring()).toBeTruthy();
  });

  it("a mounted host slot still wins over the shelf", async () => {
    stage();
    stubRects([
      { selector: "[data-vendo-app-embed]", rect: { left: 400, top: 120, width: 600, height: 400 } },
      { selector: "[data-vendo-slot]", rect: { left: 40, top: 600, width: 300, height: 200 } },
      { selector: ".fl-shelf", rect: { left: 900, top: 20, width: 120, height: 120 } },
    ]);
    shelf();
    playPinCeremony({ appId: "app_1", slot: "hero" });

    await flushFrames();
    // The slot's geometry, not the shelf's — host slots keep priority.
    expect(flight()!.keyframes[1]!.transform).toBe("translate(-360px, 480px) scale(0.5)");
  });

  it("prefers the live shelf over the day-zero ghost one, which holds no apps", async () => {
    const { panel } = stage();
    document.querySelector("[data-vendo-slot]")!.remove();
    stubRects([
      { selector: "[data-vendo-app-embed]", rect: { left: 400, top: 120, width: 600, height: 400 } },
      // Matched in order: the ghost carries both classes.
      { selector: ".fl-shelf--ghost", rect: { left: 900, top: 20, width: 120, height: 120 } },
      { selector: ".fl-shelf", rect: { left: 40, top: 600, width: 300, height: 200 } },
    ]);
    shelf(true);
    shelf();
    playPinCeremony({ appId: "app_1", dismiss: () => panel.remove() });

    await flushFrames();
    expect(flight()!.keyframes[1]!.transform).toBe("translate(-360px, 480px) scale(0.5)");
  });

  it("inks the ring with the ACCENT when it lands in our own chrome", async () => {
    const { panel } = stage();
    document.querySelector("[data-vendo-slot]")!.remove();
    stubRects([
      { selector: "[data-vendo-app-embed]", rect: { left: 400, top: 120, width: 600, height: 400 } },
      { selector: ".fl-shelf", rect: { left: 40, top: 600, width: 300, height: 200 } },
    ]);
    const section = shelf();
    section.style.color = "rgb(20, 21, 26)";
    section.style.setProperty("--vendo-accent", "rgb(10, 125, 85)");
    playPinCeremony({ appId: "app_1", slot: "hero", dismiss: () => panel.remove() });

    await flushFrames();
    flight()!.animation.onfinish!();
    // The shelf's `color` is body text, so borrowing it drew a near-black box
    // around the whole shelf — a debug outline where the payoff should be.
    expect(ring()!.getAttribute("style")).toContain("rgb(10, 125, 85)");
    expect(ring()!.getAttribute("style")).not.toContain("rgb(20, 21, 26)");
  });

  it("blooms instead of outlining when it lands in our own chrome", async () => {
    const { panel } = stage();
    document.querySelector("[data-vendo-slot]")!.remove();
    stubRects([
      { selector: "[data-vendo-app-embed]", rect: { left: 400, top: 120, width: 600, height: 400 } },
      { selector: ".fl-shelf", rect: { left: 40, top: 600, width: 300, height: 200 } },
    ]);
    shelf().style.setProperty("--vendo-accent", "rgb(10, 125, 85)");
    playPinCeremony({ appId: "app_1", slot: "hero", dismiss: () => panel.remove() });

    await flushFrames();
    flight()!.animation.onfinish!();
    // The accent alone was not enough: this theme's accent IS near-black, so a
    // full-strength 1.5px line still drew a box around the whole shelf. The
    // shelf is a WIDE band of our own chrome — it takes a soft bloom, and the
    // crisp hairline stays where it reads as a highlight (a host's slot).
    const style = ring()!.getAttribute("style")!;
    expect(style).not.toContain("1.5px");
    expect(style).toContain("color-mix");
  });

  it("a HOST slot still lends the ring its own ink, and keeps its crisp hairline", async () => {
    stage();
    (document.querySelector("[data-vendo-slot]") as HTMLElement).style.color = "rgb(180, 40, 40)";
    playPinCeremony({ appId: "app_1", slot: "hero" });

    await flushFrames();
    flight()!.animation.onfinish!();
    const style = ring()!.getAttribute("style")!;
    expect(style).toContain("rgb(180, 40, 40)");
    expect(style).toContain("1.5px");
    expect(style).not.toContain("color-mix");
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

  /** The affordance's own reading of whether the pin landed, next to the button
   *  that takes it — `usePinNudge` is what settles a pin card into "pinned". */
  function PinAndNudge({ appId }: { appId: string }) {
    const pin = usePinAction();
    const nudge = usePinNudge(appId, true);
    return (
      <>
        {pin ? <button type="button" onClick={() => pin({ appId, payload: {} })}>Pin</button> : null}
        <span data-testid="nudge">{nudge ?? "none"}</span>
      </>
    );
  }

  function PinButton() {
    const pin = usePinAction();
    return pin ? <button type="button" onClick={() => pin({ appId: "app_1", payload: {} })}>Pin</button> : null;
  }

  it("writes the placement itself, then announces — the slot fills without waiting out the poll", async () => {
    // Both spies call THROUGH to the fixture wire: the write and the read back
    // are the real ones, which is the only way this proves anything.
    const place = vi.spyOn(client.apps, "place");
    const placements = vi.spyOn(client.apps, "placements");
    const onPin = vi.fn();

    render(
      <VendoProvider client={client} onPin={onPin} pinSlot="hero">
        <VendoSlot id="hero" />
        <PinButton />
      </VendoProvider>,
    );
    // The slot is polling (and empty) before the pin.
    await waitFor(() => expect(placements).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Pin" }));

    await waitFor(() => expect(place).toHaveBeenCalledWith("app_1", "hero"));
    // The host seam still fires — after the write, never instead of it.
    await waitFor(() => expect(onPin).toHaveBeenCalledWith({ appId: "app_1", payload: {} }));
    // The default poll is 5000ms; this has to land long before that.
    expect(await screen.findByText("Invoices app surface", undefined, { timeout: 2500 })).toBeTruthy();
  });

  it("offers the affordance on a host that wired a pinSlot and no onPin at all", async () => {
    const place = vi.spyOn(client.apps, "place");
    render(
      <VendoProvider client={client} pinSlot="hero"><PinButton /></VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(place).toHaveBeenCalledWith("app_1", "hero"));
  });

  it("hides the affordance when the host wired neither onPin nor a pinSlot", () => {
    render(<VendoProvider client={client}><PinButton /></VendoProvider>);
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
  });

  it("says so and stays unpinned when the placement write does not go through", async () => {
    // The write is what makes a pin real, so a rejected one must not be
    // announced: announcing settles every affordance into its pinned state and
    // tells every mounted slot to re-read a placement that was never written.
    // The failure is REAL — the client is pointed at a wire that has since shut
    // down, so `apps.place` rejects the way it would against one that refused
    // the write. Nothing about the pin path is stubbed.
    const gone = await createWireServer();
    const goneUrl = gone.url;
    await gone.close();
    const dead = createVendoClient({ baseUrl: goneUrl });
    const place = vi.spyOn(dead.apps, "place");
    const onPin = vi.fn();

    render(
      <VendoProvider client={dead} onPin={onPin} pinSlot="hero">
        <PinAndNudge appId="app_unwritten" />
        <VendoToasts />
      </VendoProvider>,
    );
    expect(screen.getByTestId("nudge").textContent).toBe("invite");

    fireEvent.click(screen.getByRole("button", { name: "Pin" }));

    await waitFor(() => expect(place).toHaveBeenCalledWith("app_unwritten", "hero"));
    // One honest line, the same sentence the "Add to…" picker uses when its own
    // `apps.place` is refused.
    expect(await screen.findByText("That didn’t go through — try again.")).toBeTruthy();
    // The affordance never claims the slot was filled, and the host's mirror of
    // a pin never fires on a pin that did not happen.
    expect(screen.getByTestId("nudge").textContent).toBe("invite");
    expect(onPin).not.toHaveBeenCalled();
  });
});

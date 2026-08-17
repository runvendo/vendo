// @vitest-environment jsdom
// The confirmation ring is gated on the pin being CONFIRMED, not on the flight's
// timer. It used to fire from `flight.onfinish` whatever the outcome, so a
// refused `apps.place` still drew "it landed" over a slot that stayed empty.
// Every config has to be gated, so every config is covered here: Vendo's own
// write (live fixture wire, and a client pointed at one that has since shut
// down), an `onPin`-only host, whose own mirror is the only confirmation there
// is, and a direct caller of the public `playPinCeremony` that confirms nothing.
// The mirror image matters just as much: a SLOW confirmation must still ring,
// which is its own case here.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoSlot, playPinCeremony, usePinAction } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

/** jsdom ships no Web Animations API. Only the ghost's flight is kept — it is
 *  the one this test has to finish by hand. */
let flights: { onfinish: (() => void) | null }[] = [];

const ring = () => document.querySelector("[data-vendo-pin-ring]");
/** Past every microtask the ring could still be waiting on. */
const settled = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function PinButton() {
  const pin = usePinAction();
  return pin ? <button type="button" onClick={() => pin({ appId: "app_1", payload: {} })}>Pin</button> : null;
}

/** The two ends of the flight: the card the ghost copies, and the slot it
 *  lands in. */
function stage(): void {
  const card = document.createElement("div");
  card.className = "vendo-root";
  card.innerHTML = `<div data-vendo-app-embed="app_1">Your view</div>`;
  const slot = document.createElement("div");
  slot.setAttribute("data-vendo-slot", "hero");
  document.body.append(card, slot);
}

/** The ceremony measures on rAF×2, so the payoff plays over the bare page. */
async function land(): Promise<void> {
  await new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  flights[0]!.onfinish!();
}

/** Click Pin and land the ghost: everything the ring waits for except the pin. */
async function pinAndLand(tree: ReactElement): Promise<void> {
  stage();
  render(tree);
  fireEvent.click(screen.getByRole("button", { name: "Pin" }));
  await land();
}

describe("the settle ring answers to the pin, never to the timer", () => {
  const originalAnimate = Element.prototype.animate;
  const originalRect = Element.prototype.getBoundingClientRect;
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    flights = [];
    Element.prototype.animate = function animate(this: Element) {
      const animation = { onfinish: null as (() => void) | null };
      if (this.hasAttribute("data-vendo-pin-ghost")) flights.push(animation);
      return animation as unknown as Animation;
    } as unknown as typeof Element.prototype.animate;
    // jsdom lays nothing out, so both ends of the flight would measure absent.
    // `isConnected` is load-bearing, not caution: a DETACHED element measures 0
    // in a real browser, and a selector-only stub would size a node that is no
    // longer on the page — which is exactly the bug the slow-onPin case catches.
    Element.prototype.getBoundingClientRect = function rect(this: Element) {
      const laidOut = this.isConnected && this.matches("[data-vendo-app-embed], [data-vendo-slot]");
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: laidOut ? 300 : 0, height: laidOut ? 200 : 0 } as DOMRect;
    };
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    document.body.innerHTML = "";
    Element.prototype.animate = originalAnimate;
    Element.prototype.getBoundingClientRect = originalRect;
    vi.restoreAllMocks();
    await wire.close();
  });

  it("rings once the write lands", async () => {
    await pinAndLand(<VendoProvider client={client} pinSlot="hero"><PinButton /></VendoProvider>);
    await waitFor(() => expect(ring()).toBeTruthy());
  });

  it("stays dark when the write is refused", async () => {
    const gone = await createWireServer();
    const goneUrl = gone.url;
    await gone.close();
    const dead = createVendoClient({ baseUrl: goneUrl });
    const place = vi.spyOn(dead.apps, "place");

    await pinAndLand(<VendoProvider client={dead} pinSlot="hero"><PinButton /></VendoProvider>);

    await expect(place.mock.results[0]!.value as Promise<unknown>).rejects.toThrow();
    expect(ring()).toBeNull();
  });

  it("waits on the host's own onPin when that is the only confirmation there is", async () => {
    // A host wiring onPin and no pinSlot is supported, and Vendo writes nothing
    // in that config — so the ring has to hold for the host's mirror. It used to
    // fire on the flight's timer here, claiming a landing for a pin nobody had
    // confirmed and that the host may still drop.
    let mirrored = () => {};
    const onPin = vi.fn(() => new Promise<void>(resolve => { mirrored = () => resolve(); }));

    await pinAndLand(<VendoProvider client={client} onPin={onPin}><PinButton /></VendoProvider>);

    expect(onPin).toHaveBeenCalledWith({ appId: "app_1", payload: {} });
    await settled();
    expect(ring()).toBeNull();

    mirrored();
    await waitFor(() => expect(ring()).toBeTruthy());
  });

  it("still rings when the host's onPin is slow, after the slot has re-rendered", async () => {
    // A slow mirror must arrive LATE, never not at all. Landing the pin makes the
    // real VendoSlot re-read and re-render, which REPLACES its element — so the
    // ceremony cannot hold the node it flew to and measure it once the host
    // finally answers, because by then it is detached and measures 0. Nothing is
    // stubbed on either side of that seam: the write, the announce and the slot's
    // re-read are all real, which is the only way this can disagree.
    const card = document.createElement("div");
    card.className = "vendo-root";
    card.innerHTML = `<div data-vendo-app-embed="app_1">Your view</div>`;
    document.body.append(card);

    let mirrored = () => {};
    const onPin = vi.fn(() => new Promise<void>(resolve => { mirrored = () => resolve(); }));
    render(
      <VendoProvider client={client} onPin={onPin} pinSlot="hero">
        <VendoSlot id="hero" />
        <PinButton />
      </VendoProvider>,
    );
    const slot = () => document.querySelector("[data-vendo-slot]");
    await waitFor(() => expect(slot()).toBeTruthy());
    const flownTo = slot();

    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    await land();

    // The pin really landed and the slot really re-rendered, while onPin is still
    // pending — the precondition this case exists for.
    await waitFor(() => expect(slot()).not.toBe(flownTo));
    expect(flownTo!.isConnected).toBe(false);

    mirrored();
    await waitFor(() => expect(ring()).toBeTruthy());
  });

  it("rings anyway when the host's mirror REJECTS but the write already landed", async () => {
    // The write is the proof with a slot: the app really is in it. Suppressing the
    // ring because an optional mirror failed is the same lie as a timer-fired
    // ring, pointing the other way.
    const onPin = vi.fn(() => Promise.reject(new Error("host mirror exploded")));
    await pinAndLand(
      <VendoProvider client={client} onPin={onPin} pinSlot="hero"><PinButton /></VendoProvider>,
    );
    await waitFor(() => expect(ring()).toBeTruthy());
  });

  it("rings anyway when the host's mirror NEVER settles but the write already landed", async () => {
    const onPin = vi.fn(() => new Promise<void>(() => {}));
    await pinAndLand(
      <VendoProvider client={client} onPin={onPin} pinSlot="hero"><PinButton /></VendoProvider>,
    );
    await waitFor(() => expect(ring()).toBeTruthy());
  });

  it("draws no ring when a rejecting mirror is the only confirmation there is", async () => {
    // The other half of the distinction: with no slot Vendo wrote nothing, so a
    // failed mirror means the pin did not happen and nothing may claim it did.
    const onPin = vi.fn(() => Promise.reject(new Error("host mirror exploded")));
    await pinAndLand(<VendoProvider client={client} onPin={onPin}><PinButton /></VendoProvider>);

    await waitFor(() => expect(onPin).toHaveBeenCalled());
    await settled();
    expect(ring()).toBeNull();
  });

  it("draws no ring for a caller that confirms nothing at all", async () => {
    // `playPinCeremony` is a public export, so "confirmed nothing" is a shipped
    // path and not an internal detail. It gets the flight; it does not get to
    // claim the app landed.
    stage();
    playPinCeremony({ appId: "app_1", slot: "hero" });
    await land();

    await settled();
    expect(ring()).toBeNull();
  });
});

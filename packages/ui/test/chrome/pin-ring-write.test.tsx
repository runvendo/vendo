// @vitest-environment jsdom
// The confirmation ring is gated on the WRITE, not on the flight's timer. It
// used to fire from `flight.onfinish` whatever the outcome, so a refused
// `apps.place` still drew "it landed" over a slot that stayed empty. The write
// here is REAL on both sides — a live fixture wire, and a client pointed at one
// that has since shut down.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { usePinAction } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

/** jsdom ships no Web Animations API. Only the ghost's flight is kept — it is
 *  the one this test has to finish by hand. */
let flights: { onfinish: (() => void) | null }[] = [];

const ring = () => document.querySelector("[data-vendo-pin-ring]");

function PinButton() {
  const pin = usePinAction();
  return pin ? <button type="button" onClick={() => pin({ appId: "app_1", payload: {} })}>Pin</button> : null;
}

/** Click Pin and land the ghost: everything the ring waits for except the write. */
async function pinAndLand(client: VendoClient): Promise<void> {
  const card = document.createElement("div");
  card.className = "vendo-root";
  card.innerHTML = `<div data-vendo-app-embed="app_1">Your view</div>`;
  const slot = document.createElement("div");
  slot.setAttribute("data-vendo-slot", "hero");
  document.body.append(card, slot);

  render(<VendoProvider client={client} pinSlot="hero"><PinButton /></VendoProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Pin" }));
  // The ceremony measures on rAF×2, so the payoff plays over the bare page.
  await new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  flights[0]!.onfinish!();
}

describe("the settle ring answers to the placement write", () => {
  const originalAnimate = Element.prototype.animate;
  const originalRect = Element.prototype.getBoundingClientRect;
  let wire: Awaited<ReturnType<typeof createWireServer>>;

  beforeEach(async () => {
    flights = [];
    Element.prototype.animate = function animate(this: Element) {
      const animation = { onfinish: null as (() => void) | null };
      if (this.hasAttribute("data-vendo-pin-ghost")) flights.push(animation);
      return animation as unknown as Animation;
    } as unknown as typeof Element.prototype.animate;
    // jsdom lays nothing out, so both ends of the flight would measure absent.
    Element.prototype.getBoundingClientRect = function rect(this: Element) {
      const laidOut = this.matches("[data-vendo-app-embed], [data-vendo-slot]");
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: laidOut ? 300 : 0, height: laidOut ? 200 : 0 } as DOMRect;
    };
    wire = await createWireServer();
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
    await pinAndLand(createVendoClient({ baseUrl: wire.url }));
    await waitFor(() => expect(ring()).toBeTruthy());
  });

  it("stays dark when the write is refused", async () => {
    const gone = await createWireServer();
    const goneUrl = gone.url;
    await gone.close();
    const dead = createVendoClient({ baseUrl: goneUrl });
    const place = vi.spyOn(dead.apps, "place");

    await pinAndLand(dead);

    await expect(place.mock.results[0]!.value as Promise<unknown>).rejects.toThrow();
    expect(ring()).toBeNull();
  });
});

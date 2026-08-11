// @vitest-environment jsdom
/**
 * The slot registry, across the seam it actually spans.
 *
 * A slot exists because a HOST PAGE renders one, and the surface that offers it
 * as a destination ("Add to…") is on a different page — often a different
 * device. The producer (`VendoSlot`, @vendoai/ui) and the consumer (`useSlots`
 * behind `AddToPicker`, same package but a different client instance) are
 * joined by nothing but a row in the deployment's store. A test that stubs the
 * wire on either side is the producer and the consumer each holding their own
 * copy of the contract — exactly how the host-component previews shipped green
 * and dead.
 *
 * So nothing is stubbed here. A real `VendoSlot` mounts against a real
 * `createVendoClient`, whose fetch IS the real `createVendo` handler over a
 * real PGlite store; the destination is then read back through a SECOND client
 * instance — a fresh session for the same person, the "other device" — and
 * painted by the real picker.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { VendoProvider, createVendoClient, type VendoClient } from "@vendoai/ui";
import { AddToPicker, VendoSlot } from "@vendoai/ui/chrome";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

const BASE = "https://host.test/api/vendo";
const ADA: Principal = { kind: "user", subject: "user_ada" };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  document.body.innerHTML = "";
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-slot-registry-seam-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** The deployment, with the client's `fetch` routed straight into its door.
 *  Hands back how many reports have crossed it — the only thing the test needs
 *  the wire itself for. */
async function compose(): Promise<{ reports: () => number }> {
  const store = await tempStore();
  await store.ensureSchema();
  const vendo = createVendo({ principal: async () => ADA, store });

  let reports = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // jsdom's AbortSignal is not undici's, and undici's Request rejects it
    // outright; nothing here aborts, so the signal is dropped at the boundary.
    const { signal: _signal, ...rest } = init ?? {};
    const url = typeof input === "string" || input instanceof URL ? String(input) : (input as { url: string }).url;
    const request = new Request(url, rest as RequestInit);
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/slots")) reports += 1;
    return vendo.handler(request);
  }) as typeof fetch;
  cleanups.push(() => { globalThis.fetch = realFetch; });

  return { reports: () => reports };
}

// --- rendering, without a component-test harness in this package -------------

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(element: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => act(() => root.unmount()));
  await act(async () => { root.render(element); });
}

const under = (client: VendoClient, child: ReactElement) =>
  createElement(VendoProvider, { client, children: child });

/** Poll until the condition holds, with NO inner budget on purpose: the test's
 *  own timeout is the hang detector, and a tighter inner limit is a second,
 *  invisible speed limit that reports a product bug when the machine is busy. */
async function until<T>(probe: () => Promise<T | undefined> | T | undefined): Promise<T> {
  for (;;) {
    let found: T | undefined;
    await act(async () => {
      found = await probe();
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    if (found !== undefined) return found;
  }
}

const menuItems = (): string[] =>
  [...document.querySelectorAll("[role=menuitem]")].map(item => item.textContent ?? "");

const pickerButton = (): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(candidate => candidate.className.includes("fl-barpin"));

describe("the slot registry, from a mounted slot to another device's picker", () => {
  it("a slot mounted on one client is a destination on another, and re-reporting does not grow it", async () => {
    const { reports } = await compose();

    // The producer: a real slot on the host's page, reporting through the real
    // client. Nothing else in this test tells the server the slot exists.
    await mount(under(
      createVendoClient({ baseUrl: BASE }),
      createElement(VendoSlot, { id: "net-worth-card", label: "Net worth" }),
    ));

    // The consumer, on a second client instance — a fresh session for the same
    // person, which has reported nothing and shares no state with the first.
    const other = createVendoClient({ baseUrl: BASE });
    const listed = await until(async () => {
      const slots = await other.slots.list();
      return slots.length > 0 ? slots : undefined;
    });
    expect(listed.map(({ id, label }) => ({ id, label }))).toEqual([{ id: "net-worth-card", label: "Net worth" }]);
    expect(Number.isFinite(Date.parse(listed[0]!.lastSeen))).toBe(true);

    // …and through the hook the picker actually reads it with. The picker
    // renders nothing at all until it has a destination, so its bare presence
    // is the assertion that `useSlots` carried the row across.
    await mount(under(other, createElement(AddToPicker, { appId: "app_seam" })));
    const open = await until(() => pickerButton());
    await act(async () => { open.click(); });
    expect(menuItems()).toEqual(["Net worth"]);

    // Every render reports again — that is the steady state, and it is what
    // ages a removed slot out. A third session mounting the same slot must
    // refresh the row in place, never add one.
    await mount(under(
      createVendoClient({ baseUrl: BASE }),
      createElement(VendoSlot, { id: "net-worth-card", label: "Net worth" }),
    ));
    await until(() => (reports() >= 2 ? reports() : undefined));
    expect(await other.slots.list()).toHaveLength(1);
  });
});

// @vitest-environment jsdom
/**
 * H2-E / #1372, the visible half — a visitor the wire refused for missing
 * identity gets a quiet signed-out panel, not a broken-looking conversation.
 * The launcher still renders (nothing about wire health hides it), the copy is
 * host-brandable, the server's developer-facing resolver paragraph never
 * reaches the surface (consumer-voice law; the connect.test.tsx:360 shape),
 * and the conversation returns on the page's identity signal.
 */
import { VendoError } from "@vendoai/core";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay } from "../../src/chrome/index.js";
import { identityState } from "../../src/hooks/identity-state.js";
import { createWireServer } from "../wire-server.js";

const RESOLVER_PARAGRAPH = "no identity for this request: the `principal:` resolver returned null.";

describe("the overlay's signed-out panel", () => {
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

  function mount(props: Parameters<typeof VendoOverlay>[0] = {}) {
    return render(
      <VendoProvider client={client}>
        <VendoOverlay defaultOpen {...props} />
      </VendoProvider>,
    );
  }

  it("latched: the panel shows the one line, the launcher stays, the resolver paragraph never renders", async () => {
    identityState(client).note(new VendoError("forbidden", RESOLVER_PARAGRAPH));
    mount();
    await waitFor(() => expect(document.querySelector(".fl-signedout")).toBeTruthy());
    expect(document.querySelector(".fl-signedout")?.textContent).toBe("Sign in to use the agent.");
    // The launcher is untouched by wire health.
    expect(document.querySelector(".fl-launcher")).toBeTruthy();
    // No conversation furniture for a visitor who cannot converse.
    expect(document.querySelector(".fl-composer")).toBeNull();
    // The developer-facing paragraph stays with the developer.
    expect(document.body.textContent).not.toContain("resolver returned null");
    expect(document.body.textContent).not.toContain("principal");
  });

  it("the host's own words replace the default line", async () => {
    identityState(client).note(new VendoError("forbidden", RESOLVER_PARAGRAPH));
    mount({ signedOutNotice: "Log in to Maple to chat with your money." });
    await waitFor(() => expect(document.querySelector(".fl-signedout")?.textContent)
      .toBe("Log in to Maple to chat with your money."));
  });

  it("the wire's own forbidden answer raises the panel — no manual seeding", async () => {
    // Every read the overlay makes on open refuses: the first one to land
    // (warm, threads, approvals — whichever wins) must be enough.
    for (const failure of [
      { method: "POST", path: "/threads/warm" },
      { method: "GET", path: "/threads" },
      { method: "GET", path: "/approvals" },
    ]) {
      for (let i = 0; i < 4; i += 1) {
        wire.state.failures.push({
          ...failure,
          code: "forbidden",
          message: RESOLVER_PARAGRAPH,
          status: 403,
        });
      }
    }
    mount();
    await waitFor(() => expect(document.querySelector(".fl-signedout")).toBeTruthy(), { timeout: 10_000 });
    // Greptile on #1445: the refused warm must not permanently mark the client
    // as warmed — after sign-in the remounted conversation re-primes the cache.
    wire.state.failures.length = 0;
    window.dispatchEvent(new Event("vendo:identity-changed"));
    await waitFor(() => expect(document.querySelector(".fl-signedout")).toBeNull());
    const warms = () => wire.requests.filter(r => r.method === "POST" && r.path === "/threads/warm").length;
    await waitFor(() => expect(warms()).toBeGreaterThanOrEqual(2));
  });

  it("the identity signal brings the conversation back", async () => {
    identityState(client).note(new VendoError("forbidden", RESOLVER_PARAGRAPH));
    mount();
    await waitFor(() => expect(document.querySelector(".fl-signedout")).toBeTruthy());
    window.dispatchEvent(new Event("vendo:identity-changed"));
    await waitFor(() => expect(document.querySelector(".fl-signedout")).toBeNull());
    await waitFor(() => expect(document.querySelector(".fl-composer")).toBeTruthy());
  });
});

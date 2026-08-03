// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoSlot } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

vi.mock("../../src/tree/frames.js", () => ({
  AppFrame: ({ keepalive }: { keepalive?: { reopen(): Promise<unknown> } }) => (
    <>
      <div>Rendered app</div>
      <button type="button" onClick={() => void keepalive?.reopen()}>Refresh rendered app</button>
    </>
  ),
  PinMount: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe("stale app refresh recovery", () => {
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

  it("keeps a mounted slot visible and offers recovery after its reopen fails", async () => {
    render(<VendoProvider client={client}><VendoSlot id="hero" appId="app_1" /></VendoProvider>);
    expect(await screen.findByText("Rendered app")).toBeTruthy();

    vi.spyOn(client.apps, "open").mockRejectedValue(new Error("reopen failed"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh rendered app" }));

    expect((await screen.findByRole("alert")).textContent).toContain("This view may be out of date");
    expect(screen.getByText("Rendered app")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

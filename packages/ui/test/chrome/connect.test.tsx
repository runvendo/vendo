// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { ConnectCard, ConnectedAccountsPanel } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("ConnectCard and ConnectedAccountsPanel", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    await wire.close();
  });

  it("initiates, opens the broker redirect, polls to active, and fires the retry", async () => {
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    const onConnected = vi.fn();
    render(
      <VendoProvider client={client}>
        <ConnectCard
          connector="composio"
          toolkit="gmail"
          message="Connect your gmail account to run gmail_GMAIL_SEND_EMAIL."
          onConnected={onConnected}
        />
      </VendoProvider>,
    );

    expect(screen.getByRole("article", { name: "Connect gmail" }).textContent).toContain(
      "Connect your gmail account to run gmail_GMAIL_SEND_EMAIL.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect gmail" }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(opened).toHaveBeenCalledWith("https://connect.test/oauth/1", "_blank", "noopener");
    expect(screen.getByRole("status").textContent).toContain("Connected — retrying");
    expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/connections/initiate", body: { toolkit: "gmail", connector: "composio" } }),
    );
    expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "GET", path: "/connections/ca_new?connector=composio" }),
    );
  });

  it("surfaces an initiation failure inline and stays retryable", async () => {
    vi.stubGlobal("open", vi.fn());
    wire.state.failures.push({
      method: "POST",
      path: "/connections/initiate",
      code: "blocked",
      message: "connecting external accounts requires a signed-in user; sign in first",
      status: 403,
    });
    render(
      <VendoProvider client={client}>
        <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={() => undefined} />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect gmail" }));
    expect((await screen.findByRole("alert")).textContent).toContain("requires a signed-in user");
    expect(screen.getByRole("button", { name: "Connect gmail" }).hasAttribute("disabled")).toBe(false);
  });

  it("lists connected accounts and disconnects one", async () => {
    render(<VendoProvider client={client}><ConnectedAccountsPanel /></VendoProvider>);
    await screen.findByText("gmail");
    expect(screen.getByText(/Connected · since/).textContent).toContain("via composio");

    fireEvent.click(screen.getByRole("button", { name: "Disconnect gmail" }));
    await waitFor(() => expect(screen.queryByText("gmail")).toBeNull());
    expect(screen.getByText(/No connected accounts yet/)).toBeTruthy();
    expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "DELETE", path: "/connections/ca_1?connector=composio" }),
    );
  });
});

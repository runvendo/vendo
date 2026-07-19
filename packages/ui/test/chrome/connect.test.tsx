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

  it("lists accounts with real identity and severs one through confirm + undo window", async () => {
    render(<VendoProvider client={client}><ConnectedAccountsPanel undoMs={60} /></VendoProvider>);
    // Identity-forward: display name (never the raw slug), status chip, byline.
    await screen.findByText("Gmail");
    expect(screen.queryByText("gmail")).toBeNull();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText(/via Composio · connected/)).toBeTruthy();

    // Step 1 opens the inline consequence confirm — nothing is severed yet.
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Gmail" }));
    expect(screen.getByText("Disconnect Gmail?")).toBeTruthy();
    expect(wire.requests).not.toContainEqual(
      expect.objectContaining({ method: "DELETE", path: "/connections/ca_1?connector=composio" }),
    );

    // Step 2 severs into the undo row; the wire call waits for the window.
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/Gmail disconnected/)).toBeTruthy();
    expect(wire.requests).not.toContainEqual(
      expect.objectContaining({ method: "DELETE", path: "/connections/ca_1?connector=composio" }),
    );
    await waitFor(() => expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "DELETE", path: "/connections/ca_1?connector=composio" }),
    ));
    await waitFor(() => expect(screen.queryByText(/Gmail disconnected/)).toBeNull());
    expect(screen.getByText(/No connected accounts yet/)).toBeTruthy();
  });

  it("undo inside the window cancels the disconnect entirely", async () => {
    render(<VendoProvider client={client}><ConnectedAccountsPanel undoMs={30_000} /></VendoProvider>);
    await screen.findByText("Gmail");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Gmail" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/Gmail disconnected/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    // The card returns and no wire call ever fired.
    expect(await screen.findByText("Gmail")).toBeTruthy();
    await new Promise(resolve => globalThis.setTimeout(resolve, 50));
    expect(wire.requests).not.toContainEqual(
      expect.objectContaining({ method: "DELETE", path: "/connections/ca_1?connector=composio" }),
    );
  });

  it("offers connect-ahead chips in the empty state and initiates through the broker", async () => {
    vi.stubGlobal("open", vi.fn());
    wire.state.connections = [];
    render(<VendoProvider client={client}><ConnectedAccountsPanel /></VendoProvider>);
    expect(await screen.findByText(/No connected accounts yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
    await waitFor(() => expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/connections/initiate", body: { toolkit: "slack" } }),
    ));
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
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

    expect(screen.getByRole("article", { name: "Connect Gmail" }).textContent).toContain(
      "Connect your gmail account to run gmail_GMAIL_SEND_EMAIL.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(opened).toHaveBeenCalledWith("https://connect.test/oauth/1", "_blank", "noopener");
    // The card STAYS as a quiet Connected record — no "retrying" plumbing text.
    expect(screen.getByRole("status").textContent).toContain("Connected");
    expect(screen.queryByText(/retrying/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect Gmail" })).toBeNull();
    expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/connections/initiate", body: { toolkit: "gmail", connector: "composio" } }),
    );
    expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "GET", path: "/connections/ca_new?connector=composio" }),
    );
  });

  it("shows the Connecting… loading state (disabled button) while the OAuth poll runs", async () => {
    vi.stubGlobal("open", vi.fn());
    // Pre-seed the initiated account as PENDING so the poll keeps waiting.
    wire.state.connections.push({
      id: "ca_new", connector: "composio", toolkit: "gmail",
      status: "pending" as never, createdAt: "2026-07-23T00:00:00.000Z",
    });
    const onConnected = vi.fn();
    render(
      <VendoProvider client={client}>
        <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={onConnected} />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    const button = await screen.findByRole("button", { name: "Connect Gmail" });
    await waitFor(() => expect(button.textContent).toContain("Connecting…"));
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(onConnected).not.toHaveBeenCalled();
    // The OAuth completes: the broker flips the account active, the poll
    // lands, the card settles into the Connected record.
    const account = wire.state.connections.find(item => item.id === "ca_new")!;
    (account as { status: string }).status = "active";
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status").textContent).toContain("Connected");
  });

  it("a stale card (live=false) renders the Connected record when the toolkit has an active account", async () => {
    // Default wire state: gmail ca_1 is active.
    render(
      <VendoProvider client={client}>
        <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={() => undefined} live={false} />
      </VendoProvider>,
    );
    expect((await screen.findByRole("status")).textContent).toContain("Connected");
    expect(screen.queryByRole("button", { name: "Connect Gmail" })).toBeNull();
  });

  it("a stale card whose toolkit was never connected renders nothing (no re-offer)", async () => {
    wire.state.connections = [];
    const { container } = render(
      <VendoProvider client={client}>
        <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={() => undefined} live={false} />
      </VendoProvider>,
    );
    // Give the one-shot /connections read time to settle: still nothing.
    await waitFor(() => expect(wire.requests.some(r => r.method === "GET" && r.path === "/connections")).toBe(true));
    expect(container.querySelector(".fl-approval")).toBeNull();
  });

  it("still completes after a StrictMode remount (the cancel latch resets)", async () => {
    // React's dev StrictMode mounts, tears down, and re-mounts every effect.
    // A cancel ref that is only ever SET by the cleanup stays latched through
    // the second mount, so the poll loop in completeConnection exits on its
    // first check and the card sits on "Connecting…" forever (the demo host
    // had to ship reactStrictMode:false because of this).
    vi.stubGlobal("open", vi.fn());
    const onConnected = vi.fn();
    render(
      <StrictMode>
        <VendoProvider client={client}>
          <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={onConnected} />
        </VendoProvider>
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole("status")).textContent).toContain("Connected");
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
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    expect((await screen.findByRole("alert")).textContent).toContain("requires a signed-in user");
    expect(screen.getByRole("button", { name: "Connect Gmail" }).hasAttribute("disabled")).toBe(false);
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

  it("drives connect-ahead chips from the host connector catalog and initiates through the broker", async () => {
    vi.stubGlobal("open", vi.fn());
    wire.state.connections = [];
    render(
      <VendoProvider
        client={client}
        connectors={[{ toolkit: "slack", connector: "composio" }, { toolkit: "hubspot", label: "HubSpot CRM" }]}
      >
        <ConnectedAccountsPanel />
      </VendoProvider>,
    );
    expect(await screen.findByText(/No connected accounts yet/)).toBeTruthy();
    // Host labels win; unlisted toolkits proper-case.
    expect(screen.getByRole("button", { name: "Connect HubSpot CRM" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
    // The host-pinned connector rides the initiation.
    await waitFor(() => expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/connections/initiate", body: { toolkit: "slack", connector: "composio" } }),
    ));
  });

  it("hides connect-ahead entirely when the host configured no connectors", async () => {
    wire.state.connections = [];
    render(<VendoProvider client={client}><ConnectedAccountsPanel /></VendoProvider>);
    expect(await screen.findByText(/No connected accounts yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Connect / })).toBeNull();
  });

  // Demo-hygiene: non-active rows lead with a single obvious repair —
  // Reconnect is the primary action, Disconnect demoted to a quiet secondary.
  it.each(["expired", "failed"] as const)("%s row leads with a primary Reconnect and a quiet Disconnect", async status => {
    wire.state.connections = [
      { id: "ca_1", connector: "composio", toolkit: "gmail", status, createdAt: "2026-05-14T00:00:00.000Z" },
    ];
    render(<VendoProvider client={client}><ConnectedAccountsPanel /></VendoProvider>);
    await screen.findByText("Gmail");
    const reconnect = screen.getByRole("button", { name: "Reconnect Gmail" });
    expect(reconnect.className).toContain("fl-btn-primary");
    const disconnect = screen.getByRole("button", { name: "Disconnect Gmail" });
    expect(disconnect.className).toContain("fl-btn-quiet");
  });

  it("Reconnect triggers the initiate/complete flow and settles the row Connected", async () => {
    vi.stubGlobal("open", vi.fn());
    wire.state.connections = [
      { id: "ca_1", connector: "composio", toolkit: "gmail", status: "expired", createdAt: "2026-05-14T00:00:00.000Z" },
    ];
    render(<VendoProvider client={client}><ConnectedAccountsPanel /></VendoProvider>);
    await screen.findByText("Gmail");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Gmail" }));
    // The spinner state rides the button while the broker poll runs.
    await waitFor(() => expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/connections/initiate", body: { toolkit: "gmail", connector: "composio" } }),
    ));
    // The poll lands active and the list refreshes — the repaired account shows Connected.
    await screen.findByText("Connected");
  });

  it("active rows keep Disconnect as the only control — no Reconnect", async () => {
    render(<VendoProvider client={client}><ConnectedAccountsPanel /></VendoProvider>);
    await screen.findByText("Gmail");
    expect(screen.queryByRole("button", { name: /^Reconnect / })).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect Gmail" }).className).not.toContain("fl-btn-quiet");
  });
});

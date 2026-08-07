// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { ConnectCard, ConnectedAccountsPanel } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

/** A stand-in for the window `openConnectPopup` hands back: the card navigates
    it once the redirect URL lands and closes it from the opener when the account
    goes active. */
function fakePopup() {
  return { location: { replace: vi.fn() }, close: vi.fn() } as unknown as Window
    & { location: { replace: ReturnType<typeof vi.fn> }; close: ReturnType<typeof vi.fn> };
}

/** Stub `window.open` with what a browser that ALLOWS the popup returns. */
function allowPopups() {
  const popup = fakePopup();
  const open = vi.fn(() => popup);
  vi.stubGlobal("open", open);
  return { popup, open };
}

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
    vi.restoreAllMocks();
    await wire.close();
  });

  it("opens the popup INSIDE the click (before initiate), navigates it, polls to active, closes it, fires the retry", async () => {
    const { popup, open } = allowPopups();
    for (const [axis, size] of [["width", 1600], ["height", 1080]] as const) {
      Object.defineProperty(window.screen, axis, { value: size, configurable: true });
    }
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

    // THE defect this design exists for: Safari and Firefox judge a popup by
    // call-stack provenance, so the window must already be open before the
    // first await. It is blank at this instant, and initiate has not run.
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toBe("about:blank");
    expect(wire.requests.some(request => request.path === "/connections/initiate")).toBe(false);
    // …and centered on the screen, at the designed size, rather than dropped
    // in a corner. (jsdom reports a 0x0 screen, so the test states one.)
    const features = open.mock.calls[0]![2] as string;
    expect(features).toBe("popup=yes,width=520,height=680,left=540,top=200");

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    // The blank window is navigated to the broker's URL, then closed from the
    // opener once the account is live — the user never closes it themselves.
    expect(popup.location.replace).toHaveBeenCalledWith("https://connect.test/oauth/1");
    expect(popup.close).toHaveBeenCalledTimes(1);
    // The card STAYS as a quiet Connected record — no "retrying" plumbing text.
    expect(screen.getByRole("status").textContent).toContain("Connected");
    expect(screen.queryByText(/retrying/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect Gmail" })).toBeNull();
    // The receipt: what the account can now do, in the same plain words the ask
    // used — never an OAuth scope string.
    expect(screen.getByText("We can now read and send mail as you.")).toBeTruthy();
    expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/connections/initiate", body: { toolkit: "gmail", connector: "composio" } }),
    );
    expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "GET", path: "/connections/ca_new?connector=composio" }),
    );
  });

  it("says what connecting grants, in plain words, before anyone clicks", async () => {
    allowPopups();
    render(
      <VendoProvider client={client}>
        <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={() => undefined} />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: "Connect Gmail" });
    expect(card.textContent).toContain("Connecting lets us read and send mail as you.");
    // The scope strings the broker actually asks for are the grant's IDENTIFIER,
    // not its meaning — a consent surface that shows them has said nothing.
    expect(card.textContent).not.toContain("googleapis.com");
    expect(card.textContent).not.toContain("scope");
  });

  it("a host-supplied access line wins over the table", async () => {
    allowPopups();
    render(
      <VendoProvider client={client}>
        <ConnectCard
          connector="composio"
          toolkit="gmail"
          message="Connect gmail."
          access="read your last 30 days of mail"
          onConnected={() => undefined}
        />
      </VendoProvider>,
    );
    expect(screen.getByRole("article", { name: "Connect Gmail" }).textContent)
      .toContain("Connecting lets us read your last 30 days of mail.");
  });

  it("a blocked popup keeps the flow alive behind a plain link, and still completes", async () => {
    // Every browser blocks SOMETIMES (a blocker extension, a hardened profile).
    // A blocked window must not be a dead end: the connect was already initiated
    // and the poll is running, so the same URL in a tab finishes it.
    vi.stubGlobal("open", vi.fn(() => null));
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

    const link = await screen.findByRole("link", { name: "Open sign-in in a new tab" });
    expect(link.getAttribute("href")).toBe("https://connect.test/oauth/1");
    expect(screen.getByRole("status").textContent).toContain("blocked the sign-in window");
    // The poll never stopped: finishing in the tab settles the card as normal.
    const account = wire.state.connections.find(item => item.id === "ca_new")!;
    (account as { status: string }).status = "active";
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status").textContent).toContain("Connected");
  });

  it("\"Not now\" collapses to a one-line Skipped record that still offers Connect", async () => {
    allowPopups();
    const onDeclined = vi.fn();
    render(
      <VendoProvider client={client}>
        <ConnectCard
          connector="composio"
          toolkit="gmail"
          message="Connect gmail."
          onConnected={() => undefined}
          onDeclined={onDeclined}
        />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(onDeclined).toHaveBeenCalledTimes(1);
    const card = screen.getByRole("article", { name: "Connect Gmail" });
    expect(card.getAttribute("data-vendo-connect-card")).toBe("skipped");
    expect(card.textContent).toContain("Skipped — Gmail isn’t connected");
    // "Not now" is a moment's answer, not a standing one — the offer survives.
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    await waitFor(() => expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/connections/initiate" }),
    ));
  });

  it("a Skipped record survives the turn going stale (declining is what makes it stale)", async () => {
    allowPopups();
    const card = (live: boolean) => (
      <VendoProvider client={client}>
        <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={() => undefined} live={live} />
      </VendoProvider>
    );
    const { rerender } = render(card(true));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    // The decline sends the agent its continuation, so the very next render has
    // this turn stale. The record of the answer must not blink out with it.
    rerender(card(false));
    expect(screen.getByRole("article", { name: "Connect Gmail" }).getAttribute("data-vendo-connect-card")).toBe("skipped");
  });

  it("a stale card never offers \"Not now\" — it is a record, not an ask", async () => {
    // live=false + an active account renders the Connected record; the decline
    // affordance belongs only to the turn that is still waiting on an answer.
    render(
      <VendoProvider client={client}>
        <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={() => undefined} live={false} />
      </VendoProvider>,
    );
    await screen.findByRole("status");
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  });

  it("shows the Connecting… loading state (disabled button) while the OAuth poll runs", async () => {
    allowPopups();
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
    allowPopups();
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
    allowPopups();
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
    // The wire's sentence is the DEVELOPER's ("connecting external accounts
    // requires a signed-in user; sign in first"); the card says what it means
    // for the person (spec §16 law 3, LEAK 2).
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Sign in first, then connect Gmail.");
    expect(alert.textContent).not.toContain("external accounts");
    expect(screen.getByRole("button", { name: "Connect Gmail" }).hasAttribute("disabled")).toBe(false);
  });

  /**
   * V5 popup mechanics — `redirectUrl` is the ONE field of the initiate
   * response the third-party broker writes, and the card navigates a window we
   * opened to it. That window is `about:blank` opened WITHOUT `noopener` (by
   * design — the handle is what lets us close it), so it inherits this page's
   * origin: a `javascript:` URL replaced into it runs in our own document and
   * can reach `opener`. Nothing between the broker and `popup.location.replace`
   * checks the scheme. Only http(s) may be navigated to.
   */
  it("never navigates the popup to a redirect URL that is not http(s)", async () => {
    const { popup } = allowPopups();
    wire.state.redirectUrl = "javascript:window.opener.document.body.append('pwned')";
    wire.state.connections.push({
      id: "ca_new", connector: "composio", toolkit: "gmail",
      status: "pending" as never, createdAt: "2026-07-23T00:00:00.000Z",
    });
    render(
      <VendoProvider client={client}>
        <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={() => undefined} />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));

    await waitFor(() => expect(wire.requests.some(request => request.path === "/connections/initiate")).toBe(true));
    const navigated = popup.location.replace.mock.calls.map(call => String(call[0]));
    expect(navigated.filter(url => !/^https?:\/\//.test(url))).toEqual([]);
  });

  it("never offers a non-http(s) redirect as the blocked-popup fallback link", async () => {
    vi.stubGlobal("open", vi.fn(() => null));
    wire.state.redirectUrl = "javascript:window.opener.document.body.append('pwned')";
    wire.state.connections.push({
      id: "ca_new", connector: "composio", toolkit: "gmail",
      status: "pending" as never, createdAt: "2026-07-23T00:00:00.000Z",
    });
    render(
      <VendoProvider client={client}>
        <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={() => undefined} />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));

    await waitFor(() => expect(wire.requests.some(request => request.path === "/connections/initiate")).toBe(true));
    // React neutralizes a `javascript:` href, so what the person gets is a
    // primary button that does nothing while the card claims the poll is
    // running — a dead end dressed as the recovery path. Refuse the URL at the
    // seam instead, and this link is never offered.
    expect(screen.queryByRole("link", { name: "Open sign-in in a new tab" })).toBeNull();
  });

  /**
   * V5 — the timed-out phase: the poll's deadline passed with nothing settled.
   * A deadline is not a refusal, so the card says nothing changed (no error
   * alert) and re-offers. Untested until now — the whole phase shipped unproven.
   * The clock is moved rather than waited on: `completeConnection` reads
   * `Date.now()` once for the deadline and once per loop turn, so a stub that
   * jumps past the window ends the poll on its first check.
   */
  it("a poll that reaches its deadline settles on the timed-out record, and Try again re-runs the flow", async () => {
    allowPopups();
    wire.state.connections.push({
      id: "ca_new", connector: "composio", toolkit: "gmail",
      status: "pending" as never, createdAt: "2026-07-23T00:00:00.000Z",
    });
    let clock = Date.parse("2026-08-06T00:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 200_000));
    const onConnected = vi.fn();
    render(
      <VendoProvider client={client}>
        <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={onConnected} />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));

    const card = await screen.findByRole("article", { name: "Connect Gmail" });
    await waitFor(() => expect(card.getAttribute("data-vendo-connect-card")).toBe("timed-out"));
    expect(card.textContent).toContain("Nothing changed — the sign-in never finished.");
    // A deadline is not a refusal: no failure copy, and nothing was connected.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();

    // Try again re-runs the whole flow from the top.
    const before = wire.requests.filter(request => request.path === "/connections/initiate").length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(
      wire.requests.filter(request => request.path === "/connections/initiate").length,
    ).toBeGreaterThan(before));
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

  // A refusal the person cannot retry away must not be dressed as a wobble:
  // "try again in a moment" sends them back to the same wall forever.
  it.each([
    ["blocked", 401, "Sign in first, then disconnect Gmail."],
    ["forbidden", 403, "You don’t have access to disconnect Gmail here."],
    ["not-implemented", 501, "Disconnecting Gmail isn’t set up here — there’s nothing you can do from this screen."],
    ["cloud-required", 402, "Disconnecting Gmail isn’t set up here — there’s nothing you can do from this screen."],
  ] as const)("a %s disconnect refusal says what to do instead of promising a retry", async (code, status, sentence) => {
    render(<VendoProvider client={client}><ConnectedAccountsPanel undoMs={30} /></VendoProvider>);
    await screen.findByText("Gmail");
    wire.state.failures.push({
      method: "DELETE",
      path: "/connections/ca_1",
      code,
      message: "the wire's own sentence, which is the developer's",
      status,
    });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Gmail" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(sentence);
    // The wire's own words never reach the person (spec §16 law 3).
    expect(alert.textContent).not.toContain("developer");
  });

  // The broker answers not-found for any id outside this person's own scope
  // (`ConnectorConnections`' frozen rule), so the row on screen is stale: the
  // account is ALREADY gone. Their intent is a fact — reporting a failure, or
  // leaving the row sitting there, would both be lies.
  it("a disconnect for an account that is already gone drops the row instead of erroring", async () => {
    render(<VendoProvider client={client}><ConnectedAccountsPanel undoMs={30} /></VendoProvider>);
    await screen.findByText("Gmail");
    wire.state.failures.push({
      method: "DELETE",
      path: "/connections/ca_1",
      code: "not-found",
      message: "connection not found: ca_1",
      status: 404,
    });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Gmail" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    // …and the server never had it: another tab, or the broker's own console.
    wire.state.connections = [];

    expect(await screen.findByText(/No connected accounts yet/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // not-found is also what `byoConnections` throws when the CONNECTOR is
  // missing ("no connector named composio supports connections") — an absent
  // broker, not an absent account, and the client cannot tell those apart. So
  // dropping a row is never permanent: a list read the server actually answers
  // that still carries the account overrules it, and the row comes back.
  it("a severed row the server still reports comes back on the next read it answers", async () => {
    render(<VendoProvider client={client}><ConnectedAccountsPanel undoMs={30} /></VendoProvider>);
    await screen.findByText("Gmail");
    // The account is live; it is the broker lookup that is missing.
    wire.state.failures.push({
      method: "DELETE",
      path: "/connections/ca_1",
      code: "not-found",
      message: "no connector named composio supports connections",
      status: 404,
    });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Gmail" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    // The read that follows answers, and it still has the account: it wins.
    await waitFor(() => expect(screen.getByText(/via Composio · connected/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Disconnect Gmail" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // An account is gone the moment the WIRE says so — by the disconnect
  // succeeding, or by it answering not-found. Neither may wait on the list read
  // that follows to prove it: when that read fails the hook keeps its last
  // page, so the row the person just disconnected sits there looking connected
  // with nothing said. "The button did nothing" is the same lie as before.
  it.each([
    ["succeeded", undefined],
    ["answered not-found", "not-found"],
  ] as const)("a disconnect that %s drops the row even when the list read after it fails", async (situation, deleteCode) => {
    render(<VendoProvider client={client}><ConnectedAccountsPanel undoMs={30} /></VendoProvider>);
    await screen.findByText("Gmail");
    if (deleteCode !== undefined) {
      wire.state.failures.push({
        method: "DELETE",
        path: "/connections/ca_1",
        code: deleteCode,
        message: "connection not found: ca_1",
        status: 404,
      });
    }
    // The list read the disconnect chases with is the one that fails.
    wire.state.failures.push({
      method: "GET",
      path: "/connections",
      code: "unavailable",
      message: `the list read failed after the disconnect ${situation}`,
      status: 503,
    });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Gmail" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(await screen.findByText(/No connected accounts yet/)).toBeTruthy();
    expect(screen.queryByText(/via Composio · connected/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // Reserved for the faults that DO clear on their own. `validation` rides here
  // deliberately: the client stamps it on any envelope that carries no code of
  // its own, so it is the unknown bucket, not a statement about the deployment.
  it.each([
    ["conflict", 409],
    ["validation", 400],
    // What `raiseCloudError` stamps on a console 5xx — an unknown code to the
    // client, and the shape every unmapped broker failure arrives in.
    ["unavailable", 500],
  ] as const)("a transient disconnect failure (%s) still offers the retry that can work", async (code, status) => {
    render(<VendoProvider client={client}><ConnectedAccountsPanel undoMs={30} /></VendoProvider>);
    await screen.findByText("Gmail");
    wire.state.failures.push({ method: "DELETE", path: "/connections/ca_1", code, message: "broker busy", status });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Gmail" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("We couldn’t disconnect Gmail — it is still connected. Try again in a moment.");
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
    // The AUTO catalog is what feeds connect-ahead, and the fixture's is
    // non-empty — so this test could only pass by beating the in-flight fetch to
    // the assertion, which it lost about one run in three under load. Emptying
    // the catalog is what its own name describes, and makes it deterministic.
    wire.state.catalog = [];
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

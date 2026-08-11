// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { ConnectCard } from "../../src/chrome/index.js";
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

describe("ConnectCard", () => {
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

    // ⚠️ TEST EDIT (C2 · Integration row): the model's sentence used to be its
    // own card line and kept its full stop. It is now the first item of the
    // dot-joined notes line, where a trailing stop before " · " reads as a typo.
    // Asserted as the EXACT items the line renders — a substring check would
    // pass just as well if the fragment shaping (stop dropped, access copy
    // capitalized) were deleted, which is the whole reason it exists.
    const notes = screen.getByRole("article", { name: "Connect Gmail" })
      .querySelector("ul.fl-approval-sub")!;
    expect([...notes.querySelectorAll("li")].map(item => item.textContent)).toEqual([
      "Connect your gmail account to run gmail_GMAIL_SEND_EMAIL",
      "Read and send mail as you",
      "Secured with OAuth",
    ]);
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
    // used — never an OAuth scope string. The line's NAME follows its contents
    // into the past tense; "what connecting Gmail does" over a receipt is a
    // screen reader being told the wrong thing.
    expect(screen.getByText("We can now read and send mail as you.")).toBeTruthy();
    expect(screen.getByRole("list", { name: "What Gmail can now do" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "What connecting Gmail does" })).toBeNull();
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
    // ⚠️ TEST EDIT (C2 · Integration row): the access copy used to be wrapped in
    // its own sentence ("Connecting lets us …"). It is now a note on the one
    // quiet line, so it is asserted as that note — same words, same source
    // (`toolkitAccessCopy`), same law: what this grants, before anyone clicks.
    expect(card.textContent).toContain("Read and send mail as you");
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
      .toContain("Read your last 30 days of mail");
  });

  /** C2 · Integration row — THE defect this layout was drawn for: the toolkit's
   *  mark rode the shell's 28px icon well, whose radius and fill cropped the
   *  Gmail M. The mark is now raw — its own aspect ratio, no well behind it. */
  it("shows the toolkit's mark RAW: no icon well, nothing to crop it", async () => {
    allowPopups();
    const { container } = render(
      <VendoProvider client={client}>
        <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={() => undefined} />
      </VendoProvider>,
    );
    expect(container.querySelector(".fl-card-ic")).toBeNull();
    const mark = container.querySelector(".fl-mark-raw img")!;
    expect(mark.getAttribute("src")).toContain("gmail");
    // The well's rule is `width: 100%; height: 100%` inside a 28px box with a
    // radius and a fill; the raw mark caps both edges instead, so a wide logo
    // letterboxes rather than filling, and nothing clips it.
    const { CHROME_CSS } = await import("../../src/chrome/chrome-css.js");
    expect(CHROME_CSS).toContain(".fl-mark-raw img { max-width: 26px; max-height: 26px;");
    expect(CHROME_CSS).toMatch(/\.fl-mark-raw \{(?![^}]*overflow: hidden)[^}]*\}/);
    expect(CHROME_CSS).toMatch(/\.fl-mark-raw \{(?![^}]*background)[^}]*\}/);
  });

  /** The mark is REMOTE, so it can 404 — and the fallback is a glyph, which the
      raw box must size like the logo it replaces. Undressed it drew at its own
      15px beside 26px marks and read as a different component. */
  it("sizes the fallback glyph when the logo 404s", async () => {
    allowPopups();
    const { container } = render(
      <VendoProvider client={client}>
        <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={() => undefined} />
      </VendoProvider>,
    );
    const mark = container.querySelector(".fl-mark-raw")!;
    fireEvent.error(mark.querySelector("img")!);
    expect(mark.querySelector("img")).toBeNull();
    expect(mark.querySelector("svg")).not.toBeNull();
    const { CHROME_CSS } = await import("../../src/chrome/chrome-css.js");
    expect(CHROME_CSS).toContain(".fl-mark-raw svg { width: 20px; height: 20px;");
  });

  it("wears no eyebrow and no OAuth chip — the row says both in words", async () => {
    allowPopups();
    const { container } = render(
      <VendoProvider client={client}>
        <ConnectCard connector="composio" toolkit="gmail" message="Connect gmail." onConnected={() => undefined} />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: "Connect Gmail" });
    expect(container.querySelector(".fl-card-eyebrow")).toBeNull();
    expect(container.querySelector(".fl-chip")).toBeNull();
    // What the chip said, said as a word on the line the person actually reads.
    expect(card.textContent).toContain("Secured with OAuth");
    // The toolkit's name is the row's first line, not an eyebrow's afterthought.
    expect(card.querySelector(".fl-connect-name")!.textContent).toBe("Gmail");
    // ONE primary button, and it reads as the row's one action.
    expect(card.querySelectorAll(".fl-btn-primary")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Connect Gmail" }).textContent).toBe("Connect");
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
    const region = screen.getByRole("status");
    expect(region.textContent).toContain("blocked the sign-in window");
    // The REASON is read before the instruction: an "Open sign-in in a new tab"
    // button reached first is an order with no explanation. Same order main had,
    // and the recovery lives inside the one live region either way.
    expect(region.contains(link)).toBe(true);
    expect(region.textContent!.indexOf("blocked the sign-in window"))
      .toBeLessThan(region.textContent!.indexOf("Open sign-in in a new tab"));
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
});

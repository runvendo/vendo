// @vitest-environment jsdom
// ENG-225 — the dead-CSS affordance set, made real: copy turn actions, code
// copy, drag-drop attach + image previews, sent attachments in the transcript,
// the waiting-on-you queue, toasts, and the connect dock/tray.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoThread, VendoToasts, WaitingQueue, dismissAllVendoToasts, vendoToast } from "../../src/chrome/index.js";
import { Markdown } from "../../src/chrome/markdown.js";
import { createWireServer } from "../wire-server.js";

let clipboard: string[];

beforeEach(() => {
  clipboard = [];
  Object.assign(navigator, {
    clipboard: { writeText: (text: string) => { clipboard.push(text); return Promise.resolve(); } },
  });
});

afterEach(() => {
  cleanup();
  // The toast queue is a module singleton — drain it so no test inherits cards.
  act(() => dismissAllVendoToasts());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("copy affordances (ENG-225)", () => {
  it("copies a fenced code block via the .fl-codeblock hover button", async () => {
    const view = render(<Markdown text={"```js\nconst x = 1;\n```"} />);
    const copy = await screen.findByRole("button", { name: "Copy code" });
    expect(view.container.querySelector(".fl-codeblock pre")).toBeTruthy();
    fireEvent.click(copy);
    await waitFor(() => expect(clipboard).toEqual(["const x = 1;\n"]));
    await screen.findByText("Copied");
  });

  it("copies a settled assistant turn from its turn actions", async () => {
    const wire = await createWireServer();
    const client = createVendoClient({ baseUrl: wire.url });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");
    const copy = await screen.findByRole("button", { name: "Copy message" });
    fireEvent.click(copy);
    await waitFor(() => expect(clipboard).toEqual(["Existing thread"]));
    await wire.close();
  });
});

describe("drag-drop attach + previews (ENG-225)", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    await wire.close();
  });

  function dragPayload(files: File[]) {
    return { dataTransfer: { types: ["Files"], files } };
  }

  it("shows the drop zone during a file drag and attaches the dropped file", async () => {
    const view = render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");
    const composer = screen.getByRole("form", { name: "Message composer" });

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.dragEnter(composer, dragPayload([file]));
    // Lane pick 2E — the drop surface is the WHOLE thread now: the overlay is
    // the thread-level card (the composer no longer carries a drag class).
    expect(view.container.querySelector(".fl-drop--thread")).toBeTruthy();

    fireEvent.drop(composer, dragPayload([file]));
    expect(view.container.querySelector(".fl-drop")).toBeNull();
    // Non-image chip: extension badge + name + size. Lane pick 2F reads the
    // file eagerly on attach (ring while reading), so wait for the settled
    // ready chip before asserting the badge.
    await screen.findByText("notes.txt");
    await waitFor(() => expect(view.container.querySelector(".fl-att-ext")?.textContent).toBe("TXT"));
    expect(view.container.querySelector(".fl-att-file")).toBeTruthy();
  });

  it("ignores drags that carry no files (text selections)", async () => {
    const view = render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");
    const composer = screen.getByRole("form", { name: "Message composer" });
    fireEvent.dragEnter(composer, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(view.container.querySelector(".fl-drop")).toBeNull();
  });

  it("previews image attachments as thumbnails and renders them in the sent turn", async () => {
    const objectUrls: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: (file: File) => { const url = `blob:${file.name}`; objectUrls.push(url); return url; },
      revokeObjectURL: () => undefined,
    }));
    const view = render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");
    const composer = screen.getByRole("form", { name: "Message composer" });

    const image = new File([new Uint8Array([137, 80])], "chart.png", { type: "image/png" });
    fireEvent.drop(composer, { dataTransfer: { types: ["Files"], files: [image] } });

    // Composer chip is the designed image thumbnail, not a filename pill.
    await waitFor(() => expect(view.container.querySelector(".fl-att-img img")).toBeTruthy());
    expect(objectUrls).toEqual(["blob:chart.png"]);

    const textarea = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(textarea, { target: { value: "here is the chart" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // The sent turn renders the image beside the bubble (.fl-turn-user-att).
    await waitFor(() => expect(view.container.querySelector(".fl-turn-user-att .fl-msg-img img")).toBeTruthy());
    await screen.findByText("here is the chart");
  });
});

describe("waiting-on-you queue (ENG-225)", () => {
  it("lists pending approvals and empties after a decision", async () => {
    const wire = await createWireServer();
    const client = createVendoClient({ baseUrl: wire.url });
    const view = render(<VendoProvider client={client}><WaitingQueue pollMs={0} /></VendoProvider>);

    const region = await screen.findByRole("region", { name: "Waiting on you" });
    within(region).getByText(/Waiting on you ·/);
    // No host metadata in this render → the ENG-216 prettified-id fallback.
    within(region).getByText("Email send");
    // spec §16.2 — the row humanizes the REAL args (dt "To" / dd the address);
    // the server's own preview string is never what an end user reads.
    within(region).getByText("a@example.com");
    expect(region.textContent).not.toContain("to a@example.com");
    within(region).getByText(/^Asked /);

    fireEvent.click(within(region).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(view.container.querySelector(".fl-waiting")).toBeNull());
    await wire.close();
  });
});

describe("toasts (ENG-225)", () => {
  it("renders an imperative toast and dismisses it", async () => {
    const wire = await createWireServer();
    const client = createVendoClient({ baseUrl: wire.url });
    render(<VendoProvider client={client}><VendoToasts /></VendoProvider>);

    let acted = false;
    act(() => {
      vendoToast({ text: "Invoice watcher finished", actions: [{ label: "View", onAction: () => { acted = true; } }], durationMs: 0 });
    });
    const region = await screen.findByRole("region", { name: "Notifications" });
    within(region).getByText("Invoice watcher finished");
    fireEvent.click(within(region).getByRole("button", { name: "View" }));
    expect(acted).toBe(true);

    fireEvent.click(within(region).getByRole("button", { name: "Dismiss notification" }));
    await waitFor(() => expect(screen.queryByText("Invoice watcher finished")).toBeNull());
    await wire.close();
  });

  /** M35 — WCAG 2.2.1. A timed toast carrying an ACTION is a time limit on an
   *  interactive control, and there was no way to stop it: a reader still
   *  parsing the sentence, or a switch user still travelling to the button,
   *  lost both. */
  it("pauses its countdown while a pointer is over it, and resumes on the way out", async () => {
    const wire = await createWireServer();
    const client = createVendoClient({ baseUrl: wire.url });
    render(<VendoProvider client={client}><VendoToasts /></VendoProvider>);
    // ⚠️ THE BUDGET IS THE TEST'S OWN, not the runner's. These two cases used
    // `durationMs: 80`, which made the SETUP a race: everything between minting
    // the toast and pausing it (an async `findByRole`) had to finish inside
    // 80ms of wall clock, or the countdown had already elapsed and the toast
    // was gone before the pause could hold anything. Under coverage
    // instrumentation on a loaded CI runner it does not, and the keyboard case
    // failed exactly that way (`expected null not to be null`). 800ms of
    // headroom to arrange, then a wait that still OUTLASTS the countdown — so
    // the assertion continues to prove the pause, not merely the delay.
    act(() => {
      vendoToast({ text: "Invoice watcher finished", actions: [{ label: "View", onAction: () => undefined }], durationMs: 800 });
    });
    const region = await screen.findByRole("region", { name: "Notifications" });

    fireEvent.mouseEnter(region);
    // Well past the countdown: it is held, and so is the action.
    await new Promise(resolve => setTimeout(resolve, 1_200));
    expect(screen.queryByText("Invoice watcher finished")).not.toBeNull();
    expect(within(region).getByRole("button", { name: "View" })).toBeTruthy();

    fireEvent.mouseLeave(region);
    await waitFor(() => expect(screen.queryByText("Invoice watcher finished")).toBeNull(), { timeout: 3_000 });
    dismissAllVendoToasts();
    await wire.close();
  });

  it("pauses for the keyboard too — focus inside the stack holds the countdown", async () => {
    const wire = await createWireServer();
    const client = createVendoClient({ baseUrl: wire.url });
    render(<VendoProvider client={client}><VendoToasts /></VendoProvider>);
    act(() => {
      vendoToast({ text: "Payroll run finished", actions: [{ label: "View", onAction: () => undefined }], durationMs: 800 });
    });
    const region = await screen.findByRole("region", { name: "Notifications" });
    fireEvent.focus(within(region).getByRole("button", { name: "View" }));
    // Outlasts the countdown, so this proves the HOLD (see the note above).
    await new Promise(resolve => setTimeout(resolve, 1_200));
    expect(screen.queryByText("Payroll run finished")).not.toBeNull();
    dismissAllVendoToasts();
    await wire.close();
  });

  it("raises a toast for an approval that parks AFTER mount, not the backlog", async () => {
    const wire = await createWireServer();
    const client = createVendoClient({ baseUrl: wire.url });
    render(<VendoProvider client={client}><VendoToasts approvals pollMs={40} /></VendoProvider>);

    // The pre-existing approval is baseline — it must NOT toast.
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(screen.queryByText(/Waiting on you:/)).toBeNull();

    // A newly parked approval does.
    wire.state.approvals.push({
      ...wire.state.approvals[0]!,
      id: "apr_2",
      call: { id: "call_2", tool: "host_invoice_delete", args: {} },
      descriptor: { name: "host_invoice_delete", description: "Delete invoice", inputSchema: {}, risk: "destructive" },
    });
    await screen.findByText(/Waiting on you: Invoice delete/);
    // Exactly one card — a poll tick must never re-toast a seen approval.
    expect(screen.getAllByText(/Waiting on you: Invoice delete/)).toHaveLength(1);

    // Approving from the toast decides it and withdraws the card.
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(wire.state.approvals.some(item => item.id === "apr_2")).toBe(false));
    await waitFor(() => expect(screen.queryByText(/Waiting on you: Invoice delete/)).toBeNull());
    await wire.close();
  });

  it("keeps the approval toast when the decide fails, so Approve stays retryable", async () => {
    const wire = await createWireServer();
    const client = createVendoClient({ baseUrl: wire.url });
    render(<VendoProvider client={client}><VendoToasts approvals pollMs={40} /></VendoProvider>);

    // Baseline settles, then a new approval parks and toasts.
    await new Promise(resolve => setTimeout(resolve, 120));
    wire.state.approvals.push({
      ...wire.state.approvals[0]!,
      id: "apr_2",
      call: { id: "call_2", tool: "host_invoice_delete", args: {} },
      descriptor: { name: "host_invoice_delete", description: "Delete invoice", inputSchema: {}, risk: "destructive" },
    });
    await screen.findByText(/Waiting on you: Invoice delete/);

    // The wire rejects the next decide (server 500 / dropped connection).
    wire.state.failures.push({ method: "POST", path: "/approvals/decide", code: "boom", message: "kaboom", status: 500 });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(
      wire.requests.filter(request => request.method === "POST" && request.path === "/approvals/decide"),
    ).toHaveLength(1));
    // The approval is still parked server-side — the toast must NOT vanish as
    // if the approval succeeded (a dismissed card can never re-surface here).
    expect(wire.state.approvals.some(item => item.id === "apr_2")).toBe(true);
    expect(screen.queryByText(/Waiting on you: Invoice delete/)).not.toBeNull();

    // The failure consumed, a second Approve decides it and withdraws the card.
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(wire.state.approvals.some(item => item.id === "apr_2")).toBe(false));
    await waitFor(() => expect(screen.queryByText(/Waiting on you: Invoice delete/)).toBeNull());
    await wire.close();
  });
});

describe("connect dock + tray (ENG-225)", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    await wire.close();
  });

  const CONNECTORS = [{ toolkit: "gmail", label: "Gmail" }, { toolkit: "slack", label: "Slack" }];

  it("renders no dock when the host force-disables it (connectors={[]})", async () => {
    const view = render(
      <VendoProvider client={client} connectors={[]}><VendoThread threadId="thr_1" /></VendoProvider>,
    );
    await screen.findByText("Existing thread");
    expect(view.container.querySelector(".fl-dock")).toBeNull();
  });

  it("auto-derives the dock from the wire catalog when no connectors prop is passed", async () => {
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");
    // gmail + slack come from the wire's /connections/catalog, not a prop.
    const dock = await screen.findByRole("button", { name: "Connect tools" });
    fireEvent.click(dock);
    const tray = await screen.findByRole("dialog", { name: "Connect tools" });
    await within(tray).findByRole("button", { name: /connect slack/i });
  });

  it("keeps the dock when the auto catalog resolves empty and the tray says so honestly", async () => {
    // 2026-07 demo feedback — the dock used to vanish whenever the auto
    // catalog came back empty, which also swallowed fetch failures. Only an
    // explicit connectors={[]} hides the entry point now.
    // Both fixtures must be empty, not just the catalog. The tray reads two
    // independent sources (`/connections/catalog` and `/connections`), and the
    // fixture ships an active gmail account: once `/connections` lands, that
    // account renders as connected — correctly, since "no tools available" is
    // NOT the honest state for someone who has one — and the empty copy is
    // gone. Emptying only the catalog left the copy on screen for the single
    // event-loop turn between the two responses, so this assertion passed or
    // failed on machine load (measured ~2/8 failures at HEAD and 3/8 at the
    // pre-wave baseline, i.e. a flake that predates this wave).
    wire.state.catalog = [];
    wire.state.connections = [];
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");
    const dock = await screen.findByRole("button", { name: "Connect tools" });
    fireEvent.click(dock);
    const tray = await screen.findByRole("dialog", { name: "Connect tools" });
    await within(tray).findByText("No tools are available to connect yet.");
  });

  it("keeps the dock when the auto catalog fetch FAILS and the tray offers a retry", async () => {
    // A failed fetch evicts itself from the per-client cache so every new
    // consumer mount refetches; a deterministic always-failing catalog (until
    // the test flips it) keeps the error state stable however many surfaces
    // remount along the way.
    let catalogHealthy = false;
    const flaky: VendoClient = {
      ...client,
      connections: {
        ...client.connections,
        catalog: async () => {
          if (!catalogHealthy) throw new Error("kaboom");
          return [{ toolkit: "slack", connector: "conn_slack" }];
        },
      },
    };
    render(<VendoProvider client={flaky}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");
    // The dock button no longer vanishes on a failed catalog fetch.
    const dock = await screen.findByRole("button", { name: "Connect tools" });
    fireEvent.click(dock);
    const tray = await screen.findByRole("dialog", { name: "Connect tools" });
    await within(tray).findByText(/Couldn.t load the available tools/);
    // The retry refetches and the catalog lands.
    catalogHealthy = true;
    fireEvent.click(within(tray).getByRole("button", { name: "Try again" }));
    await within(tray).findByRole("button", { name: /connect slack/i });
  });

  it("shows the dock with an active-count badge and opens the tray", async () => {
    const view = render(
      <VendoProvider client={client} connectors={CONNECTORS}><VendoThread threadId="thr_1" /></VendoProvider>,
    );
    await screen.findByText("Existing thread");
    const dock = await screen.findByRole("button", { name: "Connect tools" });
    // gmail is active in the wire fixture.
    await waitFor(() => expect(view.container.querySelector(".fl-dock-badge")?.textContent).toBe("1"));

    fireEvent.click(dock);
    const tray = await screen.findByRole("dialog", { name: "Connect tools" });
    // The tray fetches /connections on mount — group headers land async.
    await within(tray).findByText("Connected");
    await within(tray).findByText("Available");
    await within(tray).findByRole("img", { name: "Gmail connected" });
    await within(tray).findByRole("button", { name: "Connect Slack" });

    // Search filters both groups.
    fireEvent.change(within(tray).getByRole("searchbox", { name: "Search tools" }), { target: { value: "sla" } });
    expect(within(tray).queryByText("Gmail")).toBeNull();
    within(tray).getByText("Slack");

    // Escape closes and focus returns to the dock button.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Connect tools" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(dock));
  });

  it("connects an available toolkit through the broker flow", async () => {
    // The sign-in window is opened in two phases: blank inside the click (a
    // popup is judged by call-stack provenance, so it cannot wait for the
    // broker), then navigated to the real OAuth URL once initiate resolves. The
    // stand-in is what a browser that ALLOWS the popup hands back.
    const popup = { location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.fn(() => popup);
    vi.stubGlobal("open", open);
    render(
      <VendoProvider client={client} connectors={CONNECTORS}><VendoThread threadId="thr_1" /></VendoProvider>,
    );
    await screen.findByText("Existing thread");
    fireEvent.click(await screen.findByRole("button", { name: "Connect tools" }));
    const tray = await screen.findByRole("dialog", { name: "Connect tools" });

    fireEvent.click(await within(tray).findByRole("button", { name: "Connect Slack" }));
    // Phase one is blank and synchronous; phase two reaches the hosted OAuth
    // URL, and the account then polls to active.
    expect(open.mock.calls[0]?.[0]).toBe("about:blank");
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalledWith("https://connect.test/oauth/1"));
    await within(tray).findByRole("img", { name: "Slack connected" });
    // Closed from the opener once the account is live — never left hanging.
    expect(popup.close).toHaveBeenCalled();
    // The freshly connected row celebrates (one-shot bloom class).
    expect(tray.querySelector(".is-just-connected")).toBeTruthy();
  });
});

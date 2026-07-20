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
    within(region).getByText("to a@example.com");
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

  it("renders no dock without a host connector catalog", async () => {
    const view = render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");
    expect(view.container.querySelector(".fl-dock")).toBeNull();
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
    const opened: string[] = [];
    vi.stubGlobal("open", (url: string) => { opened.push(url); return null; });
    render(
      <VendoProvider client={client} connectors={CONNECTORS}><VendoThread threadId="thr_1" /></VendoProvider>,
    );
    await screen.findByText("Existing thread");
    fireEvent.click(await screen.findByRole("button", { name: "Connect tools" }));
    const tray = await screen.findByRole("dialog", { name: "Connect tools" });

    fireEvent.click(await within(tray).findByRole("button", { name: "Connect Slack" }));
    // The hosted OAuth window opened, and the account polls to active.
    await waitFor(() => expect(opened).toEqual(["https://connect.test/oauth/1"]));
    await within(tray).findByRole("img", { name: "Slack connected" });
    // The freshly connected row celebrates (one-shot bloom class).
    expect(tray.querySelector(".is-just-connected")).toBeTruthy();
  });
});

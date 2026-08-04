// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoThread } from "../../src/chrome/index.js";
import { createWireServer } from "../wire-server.js";

describe("VendoThread and VendoOverlay exports", () => {
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

  // A full streaming wire turn + gated reply + approval round-trip; CI runs the
  // whole workspace's suites in parallel, so this heavy integration test can
  // starve past the 5s default under load (275ms locally, ~7s on a loaded runner).
  it("runs a complete wire turn, renders receipts and approvals, and honors composer keys", { timeout: 20_000 }, async () => {
    let release = () => undefined;
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    expect(await screen.findByText("Existing thread")).toBeTruthy();

    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "Send the email" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(wire.requests.filter(request => request.method === "POST" && request.path === "/threads")).toHaveLength(0);
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy());
    // ENG-215 — typing is never blocked mid-turn (the composer stays enabled so
    // it can queue a follow-up and never dumps focus to <body>).
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).disabled).toBe(false);
    await act(async () => release());
    // The thread speaks in the product's voice: spec §1 (2026-08-03) put the
    // work back IN the transcript, so the call narrates as a BEAT at its
    // position in the conversation (this assertion read `.fl-ribbon` while lane
    // pick C1 stood). The ENG-216 humanized label still rules ("Email send",
    // never the raw slug), the raw name stays discoverable via data-vendo-tool,
    // and risk rides the data attr.
    await screen.findAllByText(/Email send/);
    const beat = document.querySelector("[data-vendo-tool='host_email_send']");
    expect(beat).toBeTruthy();
    expect(beat?.classList.contains("fl-beat")).toBe(true);
    expect(beat?.textContent).toContain("Email send");
    expect(beat?.getAttribute("data-vendo-approval")).toBe("write");
    // Four lines here used to assert the RIBBON narrating the PARKED call
    // ("Email send — waiting for your approval") directly above the card that
    // says "NEEDS YOUR APPROVAL / Email send" — the same words twice. A parked
    // ask is narrated ONCE, by its card: the ribbon must be gone.
    expect(document.querySelector(".fl-ribbon")).toBeNull();
    const card = await screen.findByLabelText("Approval for Send the report");
    expect(card.textContent).toContain("a@example.com");
    expect(card.textContent).toContain(
      "This tool changed since you approved it on Jul 1, 2026 — your previous permission no longer applies.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    // L38 — the morph toast is the SAME ask, so it carries the card's title. It
    // recomputed the presentation without the descriptor's authored title, so a
    // card reading "Send the report" morphed into "Email send — approved".
    expect((await screen.findByText(/— approved$/)).textContent).toBe("Send the report — approved");

    expect(await screen.findByText("Turn complete")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    expect(wire.requests.find(request => request.method === "POST" && request.path === "/threads")?.body).toMatchObject({
      threadId: "thr_1",
      message: { role: "user", parts: [{ type: "text", text: "Send the email" }] },
    });
  });

  // Demo-latency lane — the observed dead-air class: the agent streams a
  // couple of prose paragraphs, THEN works through host tools. The old gate
  // (`busy && !assistantHasVisibleText`) hid the activity row the moment any
  // text existed, so the thread showed nothing while tools ran. A running call
  // must keep a live row whatever text precedes it — since spec §1 that row is
  // the transcript's own beat, not the ribbon.
  it("keeps a live beat on a running tool call after text has streamed", { timeout: 20_000 }, async () => {
    let release = () => undefined;
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    expect(await screen.findByText("Existing thread")).toBeTruthy();

    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "[tool-after-text] build it" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    // The prose landed…
    expect(await screen.findByText(/Here is the plan/)).toBeTruthy();
    // …and the RUNNING tool call still narrates in-transcript (not dead air).
    await waitFor(() => {
      const beat = document.querySelector("[data-vendo-tool='host_list_transactions']");
      expect(beat).toBeTruthy();
      expect(beat?.classList.contains("fl-beat")).toBe(true);
      expect(beat?.textContent).toContain("List transactions");
    });

    await act(async () => release());
    expect(await screen.findByText("All done.")).toBeTruthy();
    // The settled turn drops the ribbon (no stale "running" affordance) and
    // folds its beats into the one summary row.
    await waitFor(() => expect(document.querySelector(".fl-ribbon")).toBeNull());
    expect(document.querySelector(".fl-beatsummary")).toBeTruthy();
  });

  // 2026-07 loading-state audit — the remaining dead-air class: prose has
  // streamed AND the turn's tool calls have all SETTLED, but the turn is still
  // busy (the model deciding its next step). No live part → no StatusRibbon;
  // no streaming text → no caret; text exists → no FluidThinking. The quiet
  // Working ribbon must hold that moment, then stand down when text resumes.
  it("shows the Working ribbon in the settled-tools busy gap and drops it when the turn closes", { timeout: 20_000 }, async () => {
    let release = () => undefined;
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    expect(await screen.findByText("Existing thread")).toBeTruthy();

    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "[settled-gap] build it" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    // The prose landed and the tool settled…
    expect(await screen.findByText(/Here is the plan/)).toBeTruthy();
    // …and the busy gap narrates through the generic Working ribbon.
    await waitFor(() => {
      const working = document.querySelector(".fl-ribbon--working");
      expect(working).toBeTruthy();
      expect(working?.textContent).toContain("Working");
    });
    // No stale tool ribbon poses as running (the call already settled — its
    // beat sits ticked in the transcript, which is the record, not a promise).
    expect(document.querySelector(".fl-ribbon[data-vendo-tool]")).toBeNull();
    expect(document.querySelector("[data-vendo-tool='host_list_transactions']")?.className)
      .toBe("fl-beat fl-beat-done");

    await act(async () => release());
    expect(await screen.findByText("All done.")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".fl-ribbon--working")).toBeNull());
  });

  // M22 — a REFUSED ask is terminal. It used to count as a live step forever, so
  // the between-steps ribbon never returned for the rest of the turn.
  it("brings the Working ribbon back after a denial — a refused ask is not live", { timeout: 20_000 }, async () => {
    let release = () => undefined;
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    expect(await screen.findByText("Existing thread")).toBeTruthy();

    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "[denied-gap] send it" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    // The refusal is settled in the transcript…
    await waitFor(() => expect(document.querySelector("[data-vendo-tool='host_transferMoney']")?.className)
      .toContain("fl-beat-done"));
    expect(document.body.textContent).toContain("you declined it");
    // …and the still-busy turn narrates its gap again.
    await waitFor(() => expect(document.querySelector(".fl-ribbon--working")).toBeTruthy());

    await act(async () => release());
    expect(await screen.findByText("Nothing was sent.")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".fl-ribbon--working")).toBeNull());
  });

  it("opens as a modal, traps focus, closes on Escape, and restores launcher focus", async () => {
    render(<VendoProvider client={client}><VendoOverlay /></VendoProvider>);
    const launcher = screen.getByRole("button", { name: "AI agent" });
    launcher.focus();
    fireEvent.click(launcher);
    const dialog = screen.getByRole("dialog", { name: "Vendo assistant" });
    const close = await screen.findByRole("button", { name: "Close Vendo" });
    // ENG-220: initial focus lands in the composer, not on the close button.
    const textarea = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(launcher.getAttribute("aria-expanded")).toBe("true");

    // Tab from the last focusable (the composer) wraps to the first — the
    // expand-workspace header button (split view, 2026-07), which precedes
    // new-conversation and the close X.
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand workspace" }));
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(textarea);
    expect(close).toBeTruthy(); // still present, after the new-conversation affordance

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Vendo assistant" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(launcher));
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
  });
});

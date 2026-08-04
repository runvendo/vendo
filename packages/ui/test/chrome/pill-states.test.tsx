// @vitest-environment jsdom
/**
 * LANE D — the launcher pill's background-attention states (spec §2 G1, §3 H1,
 * §4 N1):
 *
 *  idle · working-open · working-closed · ready (completion toast) · quiet dot
 *  (unseen results) · numbered badge (waiting asks)
 *
 * plus the two laws behind them: closing the panel never stops the run, and
 * NOTHING ever auto-opens or auto-folds.
 */
import type { UIMessage } from "ai";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, useAttention, type VendoClient } from "../../src/index.js";
import { VendoOverlay } from "../../src/chrome/index.js";
import { markSeen } from "../../src/chrome/discoverability.js";
import { publishThreadRun, resetRunActivity } from "../../src/chrome/run-activity.js";
import { createWireServer } from "../wire-server.js";

/** A surface key standing in for a mounted thread (useVendoThread's own). */
const SURFACE = Symbol("test-thread");

type ToolState = "input-available" | "output-available" | "approval-requested";

function assistantTurn(steps: Array<{ tool: string; state: ToolState }>, text?: string): UIMessage {
  return {
    id: "msg_a",
    role: "assistant",
    parts: [
      ...steps.map((step, index) => ({
        type: `tool-${step.tool}`,
        toolCallId: `call_${index}`,
        state: step.state,
        input: {},
        ...(step.state === "output-available" ? { output: { ok: true } } : {}),
      })),
      ...(text === undefined ? [] : [{ type: "text" as const, text, state: "done" as const }]),
    ],
  } as UIMessage;
}

const pill = () => screen.getByRole("button", { name: "AI agent" });
const ring = () => document.querySelector(".fl-launcher-ring");
const badge = () => document.querySelector(".fl-launcher-badge");
const dot = () => document.querySelector(".fl-launcher-dot");
const beat = () => document.querySelector(".fl-launcher-beat")?.textContent;
const toast = () => document.querySelector(".fl-launcher-toast");
const dialog = () => screen.queryByRole("dialog", { name: "Vendo assistant" });

describe("launcher pill — background attention", () => {
  // An unreachable wire keeps the ask count at 0 for the state matrix (the
  // badge gets its own test against the real fixture).
  const offline = createVendoClient({ baseUrl: "http://127.0.0.1:59999" });

  beforeEach(() => {
    markSeen("whisper");
    resetRunActivity();
  });

  afterEach(() => {
    cleanup();
    resetRunActivity();
    vi.useRealTimers();
  });

  const renderPill = (extra?: { onOpenChange?(open: boolean): void }) =>
    render(
      <VendoProvider client={offline} tools={{ host_list_transactions: { label: "Reading your transactions" } }}>
        <VendoOverlay {...(extra?.onOpenChange ? { onOpenChange: extra.onOpenChange } : {})} />
      </VendoProvider>,
    );

  it("idle: no ring, no dot, no badge — just the pill", () => {
    renderPill();
    expect(pill()).toBeTruthy();
    expect(ring()).toBeNull();
    expect(dot()).toBeNull();
    expect(badge()).toBeNull();
  });

  it("working while CLOSED: the pill narrates the live beat with a quiet indeterminate ring", () => {
    renderPill();
    act(() => {
      publishThreadRun(SURFACE, {
        threadId: "thr_1",
        status: "streaming",
        messages: [assistantTurn([{ tool: "host_list_transactions", state: "input-available" }])],
      });
    });
    // The humanized label (host ToolMeta wins — the ENG-216 pipeline).
    expect(beat()).toBe("Reading your transactions…");
    expect(ring()!.getAttribute("data-vendo-ring")).toBe("indeterminate");
    // The button's accessible NAME never changes under the user's cursor; the
    // live beat is announced by the polite region beside it.
    expect(pill().getAttribute("aria-label")).toBe("AI agent");
  });

  it("working while OPEN: the panel narrates, the pill stays plain", () => {
    renderPill();
    fireEvent.click(pill());
    expect(dialog()).toBeTruthy();
    act(() => {
      publishThreadRun(SURFACE, {
        threadId: "thr_1",
        status: "streaming",
        messages: [assistantTurn([{ tool: "host_list_transactions", state: "input-available" }])],
      });
    });
    expect(ring()).toBeNull();
    expect(beat()).toBeUndefined();
  });

  it("the ring goes determinate once the turn has more than one step", () => {
    renderPill();
    act(() => {
      publishThreadRun(SURFACE, {
        threadId: "thr_1",
        status: "streaming",
        messages: [assistantTurn([
          { tool: "host_list_transactions", state: "output-available" },
          { tool: "host_list_accounts", state: "output-available" },
          { tool: "host_email_send", state: "input-available" },
        ])],
      });
    });
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("3");
    // The live step is the unsettled one.
    expect(beat()).toBe("Email send…");
  });

  it("finishing while closed raises a completion toast whose View opens the panel — and NOTHING opens itself", () => {
    const onOpenChange = vi.fn();
    renderPill({ onOpenChange });
    act(() => {
      publishThreadRun(SURFACE, {
        threadId: "thr_1",
        status: "streaming",
        messages: [assistantTurn([{ tool: "host_list_transactions", state: "input-available" }])],
      });
    });
    act(() => {
      publishThreadRun(SURFACE, {
        threadId: "thr_1",
        status: "ready",
        messages: [assistantTurn([{ tool: "host_list_transactions", state: "output-available" }], "Spending is down 12% this month.")],
      });
    });
    // G1: the panel does NOT open itself, and the pill stops narrating.
    expect(dialog()).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(ring()).toBeNull();
    // H1: the toast is a headline plus the way back into the record.
    expect(toast()!.textContent).toContain("Spending is down 12% this month.");
    expect(dot()).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(dialog()).toBeTruthy();
    expect(onOpenChange).toHaveBeenCalledWith(true);
    // Viewed: both the toast and the quiet dot are done.
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();
    expect(dot()).toBeNull();
  });

  it("an ignored toast withdraws after ~6s and leaves only the quiet dot, which clears on open", () => {
    vi.useFakeTimers();
    renderPill();
    act(() => {
      publishThreadRun(SURFACE, { threadId: "thr_1", status: "streaming", messages: [assistantTurn([{ tool: "host_list_transactions", state: "input-available" }])] });
      publishThreadRun(SURFACE, { threadId: "thr_1", status: "ready", messages: [assistantTurn([{ tool: "host_list_transactions", state: "output-available" }], "All done.")] });
    });
    expect(toast()!.textContent).toContain("All done.");
    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    expect(toast()).toBeNull();
    expect(dot()).toBeTruthy();

    fireEvent.click(pill());
    expect(dot()).toBeNull();
  });

  it("a turn that ends PARKED on an ask is waiting, not finished: no toast, no dot", () => {
    renderPill();
    act(() => {
      publishThreadRun(SURFACE, { threadId: "thr_1", status: "streaming", messages: [assistantTurn([{ tool: "host_email_send", state: "input-available" }])] });
      publishThreadRun(SURFACE, { threadId: "thr_1", status: "ready", messages: [assistantTurn([{ tool: "host_email_send", state: "approval-requested" }])] });
    });
    expect(dot()).toBeNull();
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();
  });

  it("a failed turn never announces itself — the transcript owns failures (spec §15)", () => {
    renderPill();
    act(() => {
      publishThreadRun(SURFACE, { threadId: "thr_1", status: "streaming", messages: [assistantTurn([{ tool: "host_list_transactions", state: "input-available" }])] });
      publishThreadRun(SURFACE, { threadId: "thr_1", status: "error", messages: [assistantTurn([{ tool: "host_list_transactions", state: "input-available" }])] });
    });
    expect(dot()).toBeNull();
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();
  });

  it("never auto-folds: a run starting and finishing while the panel is OPEN leaves it open", () => {
    const onOpenChange = vi.fn();
    renderPill({ onOpenChange });
    fireEvent.click(pill());
    onOpenChange.mockClear();
    act(() => {
      publishThreadRun(SURFACE, { threadId: "thr_1", status: "streaming", messages: [assistantTurn([{ tool: "host_list_transactions", state: "input-available" }])] });
      publishThreadRun(SURFACE, { threadId: "thr_1", status: "ready", messages: [assistantTurn([{ tool: "host_list_transactions", state: "output-available" }], "Done.")] });
    });
    expect(dialog()).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    // Results seen as they land: no dot, and no toast shouting at a user who
    // is already looking at the conversation.
    expect(dot()).toBeNull();
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();
  });
});

describe("launcher pill — waiting asks (numbered badge)", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    markSeen("whisper");
    resetRunActivity();
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    resetRunActivity();
    await wire.close();
  });

  it("counts the waiting asks as a NUMBER, and outranks the unseen-results dot", async () => {
    render(<VendoProvider client={client}><VendoOverlay /></VendoProvider>);
    await waitFor(() => expect(badge()).toBeTruthy());
    expect(badge()!.textContent).toBe("1");
    // dot ≺ number (spec §3): with an ask waiting, the count is what shows.
    act(() => {
      publishThreadRun(SURFACE, { threadId: "thr_1", status: "streaming", messages: [assistantTurn([{ tool: "host_list_transactions", state: "input-available" }])] });
      publishThreadRun(SURFACE, { threadId: "thr_1", status: "ready", messages: [assistantTurn([{ tool: "host_list_transactions", state: "output-available" }], "Done.")] });
    });
    expect(badge()!.textContent).toBe("1");
    expect(dot()).toBeNull();
  });

  it("one attention source: deciding the ask drops the count the badge and the strip share (D3)", async () => {
    const seen: number[] = [];
    function Probe() {
      const attention = useAttention();
      seen.push(attention.askCount);
      return (
        <button type="button" onClick={() => void attention.decide(attention.asks[0]!.id, { approve: true })}>
          decide
        </button>
      );
    }
    render(<VendoProvider client={client}><Probe /></VendoProvider>);
    await waitFor(() => expect(seen.at(-1)).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "decide" }));
    await waitFor(() => expect(seen.at(-1)).toBe(0));
  });
});

describe("closing the panel mid-run (G1: closing is leaving)", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    markSeen("whisper");
    resetRunActivity();
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    resetRunActivity();
    await wire.close();
  });

  it("keeps the run alive, narrates it on the pill, then toasts the result into the record", async () => {
    let release!: () => void;
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    render(
      <VendoProvider client={client} tools={{ host_list_transactions: { label: "Reading your transactions" } }}>
        <VendoOverlay defaultOpen />
      </VendoProvider>,
    );
    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "[tool-after-text] how did I spend?" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    // The turn is mid-flight (the tool call is held open server-side).
    await waitFor(() => expect(screen.getByText("Here is the plan — pulling your data now.")).toBeTruthy());

    // Leave. The run must not stop.
    fireEvent.click(screen.getByRole("button", { name: "Close Vendo" }));
    expect(dialog()).toBeNull();
    await waitFor(() => expect(beat()).toBe("Reading your transactions…"));

    release();
    // The result finds the user where they are — and only there.
    await waitFor(() => expect(toast()?.textContent).toContain("All done."));
    expect(dialog()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    // The thread IS the record: the finished turn sits where it was left.
    expect(dialog()).toBeTruthy();
    expect(screen.getByText("All done.")).toBeTruthy();
    expect(screen.getByText("[tool-after-text] how did I spend?")).toBeTruthy();
  });
});

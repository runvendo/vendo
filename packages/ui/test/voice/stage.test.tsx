// @vitest-environment jsdom

import type { ApprovalRequest, ToolOutcome } from "@vendoai/core";
import type { ComponentType } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoStage } from "../../src/voice/index.js";
import { ScriptedVoiceDriver } from "./fake-driver.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("VendoStage", () => {
  it("humanizes every live status, announces reconnecting, and drives the blob level", async () => {
    const driver = new ScriptedVoiceDriver();
    renderStage(driver);

    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));
    const status = screen.getByRole("status", { name: "Voice status" });
    expect(status.textContent).toBe("Connecting…");
    expect(status.textContent).not.toContain("Voice: connecting");

    act(() => {
      driver.emit({ type: "state", state: "listening" });
      driver.emit({ type: "amplitude", level: 0.73 });
    });
    expect(status.textContent).toBe("Listening");
    await waitFor(() => expect(document.querySelector('[data-fluidkit-stub="voice-ball"]')?.getAttribute("data-level")).toBe("0.73"));

    act(() => driver.emit({ type: "state", state: "speaking" }));
    expect(status.textContent).toBe("Speaking");

    act(() => driver.emit({ type: "state", state: "reconnecting" }));
    expect(status.textContent).toBe("Reconnecting…");
    expect(screen.getByText("Reconnecting…", { selector: ".fl-voice-banner" })).toBeTruthy();
    expect(document.querySelector(".fl-voice-stage")?.classList.contains("is-reconnecting")).toBe(true);
    expect(document.querySelector(".fl-voice-blob")?.classList.contains("is-reconnecting")).toBe(true);
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("rolls the last three transcript lines as an aged ticker (S-C)", () => {
    const driver = new ScriptedVoiceDriver();
    renderStage(driver);
    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));

    act(() => {
      driver.emit({ type: "transcript", entry: { id: "u1", role: "user", text: "Oldest question", final: true } });
      driver.emit({ type: "transcript", entry: { id: "a1", role: "assistant", text: "Older answer", final: true } });
      driver.emit({ type: "transcript", entry: { id: "u2", role: "user", text: "Latest question", final: false } });
      driver.emit({ type: "transcript", entry: { id: "a2", role: "assistant", text: "Latest answer", final: false } });
    });

    const captions = screen.getByLabelText("Live captions");
    // Last THREE lines, oldest first — the very first line has rolled away.
    expect(captions.textContent).toBe("Older answerLatest questionLatest answer");
    expect(screen.getByText("Latest answer").classList.contains("is-age-0")).toBe(true);
    expect(screen.getByText("Latest question").classList.contains("is-age-1")).toBe(true);
    expect(screen.getByText("Older answer").classList.contains("is-age-2")).toBe(true);
    expect(screen.getByText("Latest answer").classList.contains("is-settled")).toBe(false);

    act(() => {
      driver.emit({ type: "transcript", entry: { id: "a2", role: "assistant", text: "Latest answer", final: true } });
    });
    expect(screen.getByText("Latest answer").classList.contains("is-settled")).toBe(true);
  });

  it("manages drawer focus, closes on Escape, and auto-yields to an approval", async () => {
    const driver = new ScriptedVoiceDriver();
    const pending = deferred<ApprovalRequest[]>();
    renderStage(driver, { client: testClient({ pending: () => pending.promise }) });
    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));
    act(() => {
      driver.emit({ type: "transcript", entry: { id: "u1", role: "user", text: "Check this", final: true } });
      driver.emit({ type: "transcript", entry: { id: "a1", role: "assistant", text: "I need approval", final: true } });
    });

    const toggle = screen.getByRole("button", { name: "Transcript" });
    fireEvent.click(toggle);
    const drawer = screen.getByRole("dialog", { name: "Session transcript" });
    expect(document.activeElement).toBe(drawer);
    expect(within(drawer).getByText("You")).toBeTruthy();
    expect(within(drawer).getByText("Assistant")).toBeTruthy();
    expect(within(drawer).getByText("Check this")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    await act(async () => pending.resolve([actApproval]));
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
    expect(screen.queryByRole("dialog", { name: "Session transcript" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Decline" })));
  });

  it("shows the designed empty state before transcript lines arrive", () => {
    const driver = new ScriptedVoiceDriver();
    renderStage(driver);
    const toggle = screen.getByRole("button", { name: "Transcript" });
    fireEvent.click(toggle);
    expect(screen.getByText("No transcript yet").classList.contains("fl-voice-drawer-empty")).toBe(true);
    expect(toggle.getAttribute("aria-controls")).toBe("vendo-voice-transcript");
  });

  it("decides an act-tier approval and leaves a transient approved receipt", async () => {
    const driver = new ScriptedVoiceDriver();
    const decide = vi.fn(async () => undefined);
    renderStage(driver, { client: testClient({ pending: async () => [actApproval], decide }) });
    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));
    act(() => driver.emit({ type: "state", state: "listening" }));

    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(approve.closest(".fl-voice-consent")?.classList.contains("is-listening")).toBe(true);
    expect(screen.getByText("To: ada@example.com")).toBeTruthy();
    fireEvent.click(approve);

    await waitFor(() => expect(decide).toHaveBeenCalledWith("apr_act", { approve: true }));
    expect(await screen.findByText("Approved: Send email")).toBeTruthy();
  });

  it("uses the named hand-confirm register for critical approvals and records decline", async () => {
    const driver = new ScriptedVoiceDriver();
    const decide = vi.fn(async () => undefined);
    renderStage(driver, { client: testClient({ pending: async () => [criticalApproval], decide }) });
    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));

    const confirm = await screen.findByRole("button", { name: "Confirm — Delete invoice" });
    expect(confirm.classList.contains("fl-btn-critical")).toBe(true);
    expect(confirm.closest(".fl-voice-consent")?.classList.contains("is-critical")).toBe(true);
    expect(screen.getByText("Confirm this action by hand")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    await waitFor(() => expect(decide).toHaveBeenCalledWith("apr_critical", { approve: false }));
    expect(await screen.findByText("Declined: Delete invoice")).toBeTruthy();
  });

  it("uses the rich approval register for an automation without exposing lifecycle fields", async () => {
    const driver = new ScriptedVoiceDriver();
    renderStage(driver, { client: testClient({ pending: async () => [automationApproval] }) });
    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));

    const approval = await screen.findByLabelText("Approval for Schedule weekly report");
    expect(approval.closest(".fl-voice-consent")?.classList.contains("is-automation")).toBe(true);
    expect(approval.textContent).toContain("This can run on its own after you approve it.");
    expect(approval.textContent).not.toContain("host_schedule_report");
    expect(approval.textContent).not.toContain("chat · present");
  });

  it("shows the driver error and Retry starts a clean session", () => {
    const driver = new ScriptedVoiceDriver();
    renderStage(driver);
    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));

    act(() => driver.emit({ type: "error", error: { message: "Microphone permission was denied" } }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Microphone permission was denied");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(driver.starts).toBe(2);
    expect(screen.getByRole("status", { name: "Voice status" }).textContent).toBe("Connecting…");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("toggles mute with an announced pressed state", () => {
    const driver = new ScriptedVoiceDriver();
    renderStage(driver);
    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));

    const mute = screen.getByRole("button", { name: "Mute" });
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(mute);
    const unmute = screen.getByRole("button", { name: "Unmute" });
    expect(unmute.getAttribute("aria-pressed")).toBe("true");
    expect(unmute.classList.contains("is-active")).toBe(true);
    expect(driver.muted).toEqual([true]);
  });

  it("renders deduped views as focused slides, tracks scroll, and dispatches actions", async () => {
    const driver = new ScriptedVoiceDriver();
    const call = vi.fn(async (): Promise<ToolOutcome> => ({ status: "ok", output: null }));
    const ActionButton: ComponentType<{ run?: () => Promise<ToolOutcome> }> = ({ run }) => (
      <button type="button" onClick={() => void run?.()}>Run view action</button>
    );
    renderStage(driver, { client: testClient({ call }), components: { ActionButton } });
    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));

    act(() => {
      driver.emit({ type: "view", view: textView("view-1", "app_1", "First view") });
      driver.emit({ type: "view", view: actionView("view-2", "app_2") });
    });
    expect(screen.getByText("First view")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run view action" })).toBeTruthy();
    expect(document.querySelectorAll(".fl-voice-slide")).toHaveLength(2);
    expect(document.querySelector(".fl-voice-canvas")?.classList.contains("has-views")).toBe(true);
    expect(screen.getByRole("button", { name: "Show view 2" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Run view action" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("app_2", "fn:submit", { row: 7 }));

    fireEvent.click(screen.getByRole("button", { name: "Show view 1" }));
    expect(screen.getByRole("button", { name: "Show view 1" }).getAttribute("aria-pressed")).toBe("true");

    const feed = screen.getByLabelText("Session views");
    const slides = Array.from(feed.querySelectorAll<HTMLElement>(".fl-voice-slide"));
    Object.defineProperty(feed, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(slides[0], "offsetTop", { configurable: true, value: 0 });
    Object.defineProperty(slides[0], "offsetHeight", { configurable: true, value: 100 });
    Object.defineProperty(slides[1], "offsetTop", { configurable: true, value: 100 });
    Object.defineProperty(slides[1], "offsetHeight", { configurable: true, value: 100 });
    feed.scrollTop = 100;
    fireEvent.scroll(feed);
    await waitFor(() => expect(screen.getByRole("button", { name: "Show view 2" }).getAttribute("aria-pressed")).toBe("true"));

    act(() => driver.emit({ type: "view", view: textView("view-1", "app_1", "Updated first view") }));
    expect(screen.getByText("Updated first view")).toBeTruthy();
    expect(document.querySelectorAll(".fl-voice-slide")).toHaveLength(2);
  });

  it("docks the presence into the corner pill once a view lands (P-C)", () => {
    const driver = new ScriptedVoiceDriver();
    renderStage(driver);
    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));
    act(() => driver.emit({ type: "state", state: "speaking" }));

    const stage = document.querySelector(".fl-voice-stage");
    expect(stage?.classList.contains("is-docked")).toBe(false);
    expect((document.querySelector(".fl-voice-blob") as HTMLElement).style.width).toBe("96px");

    act(() => driver.emit({ type: "view", view: textView("view-1", "app_1", "First view") }));
    expect(stage?.classList.contains("is-docked")).toBe(true);
    // The ball REMOUNTS at the pill diameter — never a scaled svg.
    expect((document.querySelector(".fl-voice-blob") as HTMLElement).style.width).toBe("30px");
    // The ticker re-anchors to the stage (the head is now the absolute pill).
    expect(screen.getByLabelText("Live captions").parentElement).toBe(stage);
  });

  it("renders idle suggestion chips and a tap starts voice (S-E)", () => {
    const driver = new ScriptedVoiceDriver();
    renderStage(driver, { suggestions: ["What's outstanding this week?", "How did June close?"] });

    const chips = screen.getByRole("group", { name: "Suggestions" });
    expect(within(chips).getAllByRole("button")).toHaveLength(2);
    expect(within(chips).getByText("or just start talking")).toBeTruthy();

    fireEvent.click(within(chips).getByRole("button", { name: "What's outstanding this week?" }));
    expect(driver.starts).toBe(1);
    // Session started — the invitation leaves with idle.
    expect(screen.queryByRole("group", { name: "Suggestions" })).toBeNull();
  });

  it("offers the spoken-yes affordance and a heard intent decides the act-tier bar (C-A)", async () => {
    const driver = new ScriptedVoiceDriver();
    const decide = vi.fn(async () => undefined);
    renderStage(driver, { client: testClient({ pending: async () => [actApproval], decide }) });
    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));
    act(() => driver.emit({ type: "state", state: "listening" }));

    await screen.findByRole("button", { name: "Approve" });
    expect(screen.getByText(/Say .approve. — or tap/)).toBeTruthy();

    act(() => driver.emit({ type: "intent", intent: "approve" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("apr_act", { approve: true }));
  });

  it("keeps criticals hand-only — a spoken approve never decides them", async () => {
    const driver = new ScriptedVoiceDriver();
    const decide = vi.fn(async () => undefined);
    renderStage(driver, { client: testClient({ pending: async () => [criticalApproval], decide }) });
    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));
    act(() => driver.emit({ type: "state", state: "listening" }));

    await screen.findByRole("button", { name: "Confirm — Delete invoice" });
    expect(screen.queryByText(/Say .approve. — or tap/)).toBeNull();

    act(() => driver.emit({ type: "intent", intent: "approve" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm — Delete invoice" })).toBeTruthy());
    expect(decide).not.toHaveBeenCalled();
  });

  it("docks the ConnectCard when a connector call needs an account (Cn-A)", () => {
    const driver = new ScriptedVoiceDriver();
    renderStage(driver);
    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));

    act(() => driver.emit({
      type: "connect",
      connect: { id: "connect-call-1", toolkit: "Slack", connector: "slack", message: "Sending Slack messages needs a connected Slack account." },
    }));

    const slot = document.querySelector(".fl-voice-connect");
    expect(slot).toBeTruthy();
    expect(within(slot as HTMLElement).getByRole("button", { name: "Connect Slack" })).toBeTruthy();
    expect(slot?.textContent).toContain("Sending Slack messages needs a connected Slack account.");
  });

  it("plays the leaving settle before handing control back to the host", () => {
    vi.useFakeTimers();
    const driver = new ScriptedVoiceDriver();
    const onSessionEnd = vi.fn();
    renderStage(driver, { onSessionEnd });
    fireEvent.click(screen.getByRole("button", { name: "Start voice" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(document.querySelector(".fl-voice-stage")?.classList.contains("is-leaving")).toBe(true);
    expect(driver.stops).toBe(1);
    expect(onSessionEnd).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(519));
    expect(onSessionEnd).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onSessionEnd).toHaveBeenCalledOnce();
  });
});

const actApproval: ApprovalRequest = {
  id: "apr_act",
  call: { id: "call_act", tool: "host_email_send", args: { to: "ada@example.com" } },
  descriptor: { name: "host_email_send", description: "Send email", inputSchema: {}, risk: "write" },
  inputPreview: "to ada@example.com",
  ctx: { principal: { kind: "user", subject: "user_1" }, venue: "chat", presence: "present" },
  createdAt: "2026-07-14T12:00:00.000Z",
};

const criticalApproval: ApprovalRequest = {
  ...actApproval,
  id: "apr_critical",
  call: { id: "call_critical", tool: "host_invoice_delete", args: { invoiceId: "inv_42" } },
  descriptor: { name: "host_invoice_delete", description: "Delete invoice", inputSchema: {}, risk: "destructive" },
  inputPreview: "invoice inv_42",
};

const automationApproval: ApprovalRequest = {
  ...actApproval,
  id: "apr_automation",
  call: { id: "call_automation", tool: "host_schedule_report", args: { channel: "Finance" } },
  descriptor: { name: "host_schedule_report", description: "Schedule weekly report", inputSchema: {}, risk: "write" },
  inputPreview: "{\"channel\":\"Finance\"}",
};

function renderStage(driver: ScriptedVoiceDriver, options: {
  client?: VendoClient;
  components?: Record<string, ComponentType>;
  onSessionEnd?: () => void;
  suggestions?: string[];
} = {}) {
  return render(
    <VendoProvider client={options.client ?? testClient()} components={options.components} voice={{ driver }}>
      <VendoStage onSessionEnd={options.onSessionEnd} suggestions={options.suggestions} />
    </VendoProvider>,
  );
}

function testClient(options: {
  pending?: VendoClient["approvals"]["pending"];
  decide?: VendoClient["approvals"]["decide"];
  call?: VendoClient["apps"]["call"];
} = {}): VendoClient {
  const client = createVendoClient({});
  return {
    ...client,
    approvals: {
      pending: options.pending ?? (async () => []),
      decide: options.decide ?? (async () => undefined),
    },
    apps: {
      ...client.apps,
      call: options.call ?? (async () => ({ status: "ok", output: null })),
    },
    status: async () => ({ posture: "rules", version: "test", blocks: {} }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function textView(id: string, appId: string, text: string) {
  return {
    id,
    appId,
    payload: {
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [{ id: "root", component: "Text", props: { text } }],
    },
  };
}

function actionView(id: string, appId: string) {
  return {
    id,
    appId,
    payload: {
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [{
        id: "root",
        component: "ActionButton",
        source: "host",
        props: { run: { $action: "fn:submit", payload: { row: 7 } } },
      }],
    },
  };
}

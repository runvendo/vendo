// @vitest-environment jsdom
/** Spec §1 + §8 D1 + §15 — the transcript shows the work.
 *
 *  Every tool call leaves a beat where it happened (reversing the old "the
 *  ribbon narrates, the transcript stays beat-free" pick), the settled turn
 *  folds its checklist into one reopenable row, the app-building call renders
 *  no beat because its card IS that step, and a FAILED turn grows no failure
 *  furniture at all — the ✕ stays in the record and the agent's prose carries
 *  the recovery. */
import type { Thread } from "@vendoai/core";
import type { UIMessage } from "ai";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoThread } from "../../src/chrome/index.js";
import { toolResultSummary } from "../../src/chrome/build-beat.js";
import { SplitViewContext, type SplitViewContextValue } from "../../src/chrome/split-view.js";
import { ThreadMessage } from "../../src/chrome/thread/message.js";
import { ThreadPart } from "../../src/chrome/thread/parts.js";
import { createWireServer } from "../wire-server.js";

const NOW = "2026-08-03T12:00:00.000Z";

function threadWith(parts: Thread["messages"][number]["parts"]): Thread {
  return {
    id: "thr_beats",
    subject: "browser-user",
    createdAt: NOW,
    updatedAt: NOW,
    messages: [{ id: "msg_beats", role: "assistant", parts }],
  };
}

function threadClient(client: VendoClient, thread: Thread): VendoClient {
  return {
    ...client,
    threads: {
      ...client.threads,
      get: async id => (id === thread.id ? thread : client.threads.get(id)),
      list: async () => [{ id: thread.id, title: thread.subject, updatedAt: thread.updatedAt }],
    },
  };
}

const doneTool = (toolCallId: string, output: unknown, input: unknown = {}) => ({
  type: "dynamic-tool" as const,
  toolName: "host_list_transactions",
  toolCallId,
  state: "output-available" as const,
  input,
  output,
});

const failedTool = (toolCallId: string) => ({
  type: "dynamic-tool" as const,
  toolName: "host_list_transactions",
  toolCallId,
  state: "output-error" as const,
  input: {},
  errorText: "upstream 500",
});

describe("toolResultSummary (the beat's short result)", () => {
  it("names a count with the output's own key, singularizing one", () => {
    expect(toolResultSummary({ transactions: new Array(142).fill(0) })).toBe("142 transactions");
    expect(toolResultSummary({ transactions: [0] })).toBe("1 transaction");
    expect(toolResultSummary(new Array(3).fill(0))).toBe("3 results");
    expect(toolResultSummary({ count: 7 })).toBe("7 results");
  });

  it("M24 — never counts an ENVELOPE key: the noun has to be a thing", () => {
    // These read "· 6 data" and "· 1 row" on a settled beat — the developer's
    // word for the payload's shape, counted like a noun.
    expect(toolResultSummary({ data: new Array(6).fill(0) })).toBeUndefined();
    expect(toolResultSummary({ rows: [0] })).toBeUndefined();
    expect(toolResultSummary({ items: new Array(4).fill(0) })).toBeUndefined();
    // A real noun beside an envelope key still gets said.
    expect(toolResultSummary({ data: new Array(6).fill(0), invoices: new Array(3).fill(0) }))
      .toBe("3 invoices");
  });

  it("stays silent when the output offers no honest count", () => {
    expect(toolResultSummary({ ok: true })).toBeUndefined();
    expect(toolResultSummary({ rows: [] })).toBeUndefined();
    expect(toolResultSummary("done")).toBeUndefined();
    expect(toolResultSummary(undefined)).toBeUndefined();
    // A tool's own prose is the TOOL's voice — never the product's line.
    expect(toolResultSummary({ message: "wrote row host_txn_9182" })).toBeUndefined();
  });
});

describe("the transcript's beats", () => {
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

  async function mount(parts: Thread["messages"][number]["parts"]) {
    const thread = threadWith(parts);
    render(
      <VendoProvider client={threadClient(client, thread)}>
        <VendoThread threadId={thread.id} />
      </VendoProvider>,
    );
    await waitFor(() => expect(document.querySelector(".fl-turn-assistant")).toBeTruthy(), { timeout: 15_000 });
  }

  // C1 + C2 over a REAL streaming turn: the beat appears at its transcript
  // position while the call runs, ticks when it settles, and the closed turn
  // folds it into one row that reopens on click.
  it("beats a running call in-transcript, then folds the settled turn into one reopenable row", { timeout: 20_000 }, async () => {
    let release = () => undefined;
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    expect(await screen.findByText("Existing thread")).toBeTruthy();

    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "[tool-after-text] build it" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    // The work is IN the conversation — a beat, not a ribbon above the composer.
    await waitFor(() => {
      const beat = document.querySelector("[data-vendo-tool='host_list_transactions']");
      expect(beat).toBeTruthy();
      expect(beat?.classList.contains("fl-beat")).toBe(true);
      expect(beat?.classList.contains("fl-beat-working")).toBe(true);
      expect(beat?.textContent).toContain("List transactions");
    });
    // C4 — the transcript OWNS the narration: the beat lives inside the message
    // list, never as a status pill parked above the composer.
    expect(document.querySelector(".fl-msglist [data-vendo-tool='host_list_transactions']")).toBeTruthy();
    expect(document.querySelector(".fl-composer [data-vendo-tool]")).toBeNull();
    // A live turn is never folded.
    expect(document.querySelector(".fl-beatsummary")).toBeNull();

    await act(async () => release());
    expect(await screen.findByText("All done.")).toBeTruthy();

    // C2 — settled: one row, with the measured wall time.
    const summary = await waitFor(() => {
      const row = document.querySelector(".fl-beatsummary");
      expect(row).toBeTruthy();
      return row as HTMLElement;
    });
    expect(summary.textContent).toMatch(/^Did 1 thing · \d+\.\d+s$/);
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-vendo-tool='host_list_transactions']")).toBeNull();

    // …and it reopens in place.
    fireEvent.click(summary);
    const beat = document.querySelector("[data-vendo-tool='host_list_transactions']");
    expect(beat?.classList.contains("fl-beat-done")).toBe(true);
    expect(document.querySelector(".fl-beatsummary")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("carries the short humanized result on a settled beat, never a raw slug", { timeout: 20_000 }, async () => {
    await mount([doneTool("call_1", { transactions: new Array(142).fill({}) })]);
    fireEvent.click(await screen.findByRole("button", { expanded: false }));
    const beat = document.querySelector("[data-vendo-tool='host_list_transactions']");
    expect(beat?.textContent).toContain("List transactions");
    expect(beat?.textContent).toContain("142 transactions");
    expect(screen.queryByText(/host_list_transactions/)).toBeNull();
  });

  // Restored history arrives folded — no beat entrance stampede, and the row
  // claims no duration for work nobody watched.
  it("restores a turn folded, counting its steps without inventing a duration", { timeout: 20_000 }, async () => {
    await mount([
      doneTool("call_1", { rows: [] }, { month: "july" }),
      doneTool("call_2", { rows: [] }, { month: "august" }),
      { type: "text", text: "Here's what I found." } as Thread["messages"][number]["parts"][number],
    ]);
    const summary = document.querySelector(".fl-beatsummary");
    expect(summary?.textContent).toBe("Did 2 things");
    expect(document.querySelectorAll(".fl-beat")).toHaveLength(0);
    expect(document.querySelector(".fl-turn-assistant")?.classList.contains("fl-no-entrance")).toBe(true);
  });

  // C3 / D1 — the app card narrates its own step ("Building your view…" → the
  // app's name), so the call behind it leaves no beat; the summary still counts
  // the step, so the record stays honest.
  it("renders NO beat for the apps call whose result became the app card, but still counts it", { timeout: 20_000 }, async () => {
    const payload = {
      formatVersion: "vendo-genui/v2",
      name: "Renewals radar",
      root: "root",
      nodes: [
        { id: "root", component: "Stack", children: ["note"] },
        { id: "note", component: "Text", props: { text: "Seven renewals." } },
      ],
    };
    await mount([
      {
        type: "dynamic-tool",
        toolName: "vendo_make",
        toolCallId: "call_build",
        state: "output-available",
        input: { request: "which renewals are coming up" },
        // The settled call answers with a RECEIPT — words only, no tree. The
        // screen it is about arrives on the view channel beside it, which is
        // what makes this call the card's own step.
        output: { id: "app_renewals", title: "Renewals radar", status: "ready", say: "Renewals radar is on your screen." },
      },
      { type: "data-vendo-view", data: { appId: "app_renewals", payload } },
    ] as unknown as Thread["messages"][number]["parts"]);
    // The card is present and IS the step.
    expect(document.querySelector("[data-vendo-app-embed='app_renewals']")).toBeTruthy();
    const summary = document.querySelector(".fl-beatsummary");
    expect(summary?.textContent).toBe("Did 1 thing");
    // Reopening the row still shows no beat for the build — not even folded away.
    // Click the summary row we just located: `getByRole("button", { expanded:
    // false })` is ambiguous the moment the composer's "Connect tools" dock
    // button (also aria-expanded=false, gated behind the connector-catalog
    // fetch) has rendered — a genuine before/after-fetch race.
    fireEvent.click(summary as HTMLElement);
    expect(document.querySelector("[data-vendo-tool='vendo_make']")).toBeNull();
    expect(screen.queryByText(/Make you a screen/)).toBeNull();
  });

  // A refused ask settles with a ✕ too, and it never poses as pending work —
  // the old beat vocabulary had no state for it, so a declined call's line sat
  // in the finished turn still saying "…".
  it("settles a declined call as its own line, not a stale heartbeat", { timeout: 20_000 }, async () => {
    await mount([
      {
        type: "dynamic-tool",
        toolName: "host_send_payment",
        toolCallId: "call_1",
        state: "output-denied",
        input: { amount: 4750 },
      },
      doneTool("call_2", { transactions: new Array(3).fill({}) }),
    ] as unknown as Thread["messages"][number]["parts"]);
    const declined = document.querySelector("[data-vendo-tool='host_send_payment']");
    expect(declined?.textContent).toContain("you declined it");
    expect(declined?.className).toBe("fl-beat fl-beat-done");
    // …and it isn't counted among the things that happened.
    expect(document.querySelector(".fl-beatsummary")?.textContent).toBe("Did 1 thing");
  });

  // The HOST's own rules refusing a call is not the person declining one. The
  // beat used to read "you declined it" directly above the card explaining they
  // had hit a limit — the two lines contradicting each other about who said no.
  it("attributes a refusal by the host's rules to the rules, not to the person", async () => {
    await mount([
      {
        type: "dynamic-tool",
        toolName: "vendo_make",
        toolCallId: "call_limited",
        state: "output-available",
        input: { request: "a spending dashboard" },
        output: {
          status: "blocked",
          reason: "The app was not built: this user has reached a limit the host's own policy sets.",
        },
      },
      { type: "data-vendo-limit", data: { message: "Maple Free builds one app a month." } },
    ] as unknown as Thread["messages"][number]["parts"]);
    const refused = document.querySelector("[data-vendo-tool='vendo_make']");
    expect(refused?.textContent).toContain("wasn't allowed");
    expect(refused?.textContent).not.toContain("you declined it");
    // Settled and quiet, like any other refusal — never a failure, and never a
    // ✓ for a build that did not happen.
    expect(refused?.className).toBe("fl-beat fl-beat-done");
    expect(refused?.querySelector(".fl-beat-tick")).toBeNull();
    // A refusal is content, not progress: the beat stays in the record instead
    // of folding into "Did 1 thing".
    expect(document.querySelector(".fl-beatsummary")).toBeNull();
    // The card the person actually reads is still beside it.
    expect(document.querySelector("[data-vendo-limit]")?.textContent).toContain("one app a month");
  });

  // Spec §15 — failure is conversation. The ✕ beat stays in the record even
  // while the turn is folded, and NOTHING else appears: no retry button, no
  // chip, no card. The recovery is the agent's own next sentence (a text part),
  // plus the shipped composer and Regenerate affordances.
  it("keeps the ✕ beat and grows ZERO failure components", { timeout: 20_000 }, async () => {
    await mount([
      failedTool("call_1"),
      { type: "text", text: "That pull timed out and nothing was changed. I'll take July in two halves." } as Thread["messages"][number]["parts"][number],
    ]);
    const turn = document.querySelector(".fl-turn-assistant") as HTMLElement;
    const errorBeat = turn.querySelector(".fl-beat-error");
    expect(errorBeat).toBeTruthy();
    expect(errorBeat?.textContent).toContain("couldn't finish");
    // A failure is not a thing the agent DID: nothing landed, so there is no
    // summary row at all — just the ✕ and the prose.
    expect(turn.querySelector(".fl-beatsummary")).toBeNull();
    // The prose recovery streamed as a text part, exactly like any other line.
    expect(turn.textContent).toContain("nothing was changed");
    // Zero failure furniture anywhere in the turn.
    for (const selector of [
      ".fl-chip", ".fl-cardshell", ".fl-approval", ".fl-buildfail",
      ".fl-btn-primary", ".fl-btn-ceremony", ".fl-connect", ".fl-waiting",
    ]) {
      expect(turn.querySelector(selector), selector).toBeNull();
    }
    for (const button of Array.from(document.querySelectorAll("button"))) {
      expect(button.textContent ?? "", button.outerHTML).not.toMatch(/retry|try again|re-?run|fix it/i);
    }
    // The errorText is a provider string — never rendered raw to a person.
    expect(screen.queryByText(/upstream 500/)).toBeNull();
  });
});

/** V4 (spec §5) — the plan-time display hint. Lane E supplies the field; the
 *  transcript's only job is the trigger: a "stage" view opens the workspace at
 *  build start, on a LIVE turn, and never fights a user who took Back-to-chat. */
describe("the V4 display hint", () => {
  afterEach(cleanup);

  function viewPart(display?: "inline" | "stage", streaming = false): UIMessage["parts"][number] {
    return {
      type: "data-vendo-view",
      data: {
        appId: "app_big",
        payload: {
          formatVersion: "vendo-genui/v2",
          name: "Cash flow",
          root: "root",
          nodes: [{ id: "root", component: "Text", props: { text: "Assembling." } }],
          ...(streaming ? { streaming: true } : {}),
          ...(display === undefined ? {} : { display }),
        },
      },
    } as unknown as UIMessage["parts"][number];
  }

  function split(overrides: Partial<SplitViewContextValue> = {}): SplitViewContextValue {
    return {
      expanded: false,
      featuredAppId: undefined,
      feature: vi.fn(),
      expandTo: vi.fn(),
      autoStage: vi.fn(),
      registerEmbed: vi.fn(),
      removeEmbed: vi.fn(),
      ...overrides,
    };
  }

  function mountCard(part: UIMessage["parts"][number], value: SplitViewContextValue, restored = false) {
    return render(
      <VendoProvider>
        <SplitViewContext.Provider value={value}>
          <ThreadPart part={part} partKey="p0" role="assistant" restored={restored} risks={new Map()} />
        </SplitViewContext.Provider>
      </VendoProvider>,
    );
  }

  it("stages the view at build start when the brain hinted stage", () => {
    const value = split();
    mountCard(viewPart("stage"), value);
    // ⚠️ SIGNATURE CHANGE (ruling 23): the ledger key is the BUILD (this part's
    // key + app), not the app id alone, so a new asked-for build of the same
    // app can stage after the user collapsed the previous one.
    expect(value.autoStage).toHaveBeenCalledWith("app_big", "p0-app_big");
    // Never `expandTo` — that is the USER's gesture and carries no one-shot
    // ledger. A hint that borrowed it fought the user (H9).
    expect(value.expandTo).not.toHaveBeenCalled();
  });

  // The stage can only feature an embed the split knows about, so a staged view
  // registers its FIRST streaming snapshot — otherwise the auto-open lands on an
  // empty stage and hides the skeleton the hint exists to show. An unhinted
  // build still registers only once it settles (today's behavior).
  it("M28 — a staged view keeps the stage up to date as the build fills in", () => {
    // The stage the hint opened froze on the FIRST snapshot for the whole
    // build, while the small rail card streamed live beside it.
    const value = split();
    const growing = (count: number): UIMessage["parts"][number] => ({
      type: "data-vendo-view",
      data: {
        appId: "app_big",
        payload: {
          formatVersion: "vendo-genui/v2",
          name: "Cash flow",
          root: "root",
          display: "stage",
          streaming: true,
          nodes: Array.from({ length: count }, (unused, index) => ({
            id: `n${index}`,
            component: "Text",
            props: { text: `line ${index}` },
          })),
        },
      },
    } as unknown as UIMessage["parts"][number]);
    const view = render(
      <VendoProvider>
        <SplitViewContext.Provider value={value}>
          <ThreadPart part={growing(1)} partKey="p0" role="assistant" restored={false} risks={new Map()} />
        </SplitViewContext.Provider>
      </VendoProvider>,
    );
    expect(value.registerEmbed).toHaveBeenCalledTimes(1);
    view.rerender(
      <VendoProvider>
        <SplitViewContext.Provider value={value}>
          <ThreadPart part={growing(4)} partKey="p0" role="assistant" restored={false} risks={new Map()} />
        </SplitViewContext.Provider>
      </VendoProvider>,
    );
    expect(value.registerEmbed).toHaveBeenCalledTimes(2);
    expect(value.registerEmbed).toHaveBeenLastCalledWith(
      "app_big",
      expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ id: "n3" })]) }),
    );
  });

  it("registers a staged view's skeleton at build start, an inline one only at settle", () => {
    const staged = split();
    mountCard(viewPart("stage", true), staged);
    expect(staged.registerEmbed).toHaveBeenCalledWith("app_big", expect.objectContaining({ streaming: true }));
    cleanup();
    const inline = split();
    mountCard(viewPart(undefined, true), inline);
    expect(inline.registerEmbed).not.toHaveBeenCalled();
  });

  it("leaves an unhinted (or inline) view exactly as it is today", () => {
    const bare = split();
    mountCard(viewPart(), bare);
    expect(bare.autoStage).not.toHaveBeenCalled();
    cleanup();
    const inline = split();
    mountCard(viewPart("inline"), inline);
    expect(inline.autoStage).not.toHaveBeenCalled();
  });

  it("never reopens a stage for restored history", () => {
    const restored = split();
    mountCard(viewPart("stage"), restored, true);
    expect(restored.autoStage).not.toHaveBeenCalled();
  });

  // The discriminating case for H9 (round B built the mechanism, this is its
  // caller). The old card-local ref returned early on `split.expanded` and left
  // the shot UNSPENT, so the next Back-to-chat re-ran the effect against a
  // collapsed split and re-opened the panel. The card must hand the hint over
  // unconditionally and let the split's ledger decide.
  it("spends the hint's shot even against an already-open workspace", () => {
    const open = split({ expanded: true, featuredAppId: "app_big" });
    mountCard(viewPart("stage"), open);
    expect(open.autoStage).toHaveBeenCalledWith("app_big", "p0-app_big");
    // It records the shot; it does NOT re-open anything.
    expect(open.expandTo).not.toHaveBeenCalled();
  });

  // §2 G1 lives in the split, not here: idempotence per app across the surface's
  // life is proven in split-view.test.tsx ("the stage hint opens the workspace
  // ONCE and Back-to-chat is final"). What this card owes is that it keeps no
  // bookkeeping of its own — one call per identity of the seam, no ref to go
  // stale.
  it("keeps no one-shot bookkeeping of its own — the split owns the ledger", () => {
    const part = viewPart("stage");
    const first = split();
    const { rerender } = mountCard(part, first);
    expect(first.autoStage).toHaveBeenCalledTimes(1);
    const tree = (value: SplitViewContextValue) => (
      <VendoProvider>
        <SplitViewContext.Provider value={value}>
          <ThreadPart part={part} partKey="p0" role="assistant" restored={false} risks={new Map()} />
        </SplitViewContext.Provider>
      </VendoProvider>
    );
    // A stable seam (the real overlay's `autoStage` is `useCallback([])`) never
    // re-fires — not on expand, not on collapse.
    rerender(tree({ ...first, expanded: true, featuredAppId: "app_big" }));
    rerender(tree({ ...first, expanded: false }));
    expect(first.autoStage).toHaveBeenCalledTimes(1);
  });
});

/** Spec §8 (build calm + D1) and §15 over the BUILD WINDOW, not just the
 *  settled state — the two states the wave E2E caught wrong:
 *
 *  · MID-BUILD the step narrated TWICE (a "Make you a screen…" beat AND the card's
 *    own "Building your view…" bar), because the beat suppression only fired
 *    once the finished view part existed while the card goes up at build START.
 *  · A FAILED build left the card sweeping its hairline over a skeleton on a
 *    turn that was over — and held the split view's stage on that skeleton. */
describe("a build in flight, and a build that dies", () => {
  afterEach(cleanup);

  const PAYLOAD = {
    formatVersion: "vendo-genui/v2",
    name: "Where my money went",
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "Assembling." } }],
  };

  /** The skeleton the card shows mid-build; `display` is the V4 hint that also
      puts it on the stage. */
  const forming = (display?: "stage") => ({
    type: "data-vendo-view",
    data: {
      appId: "app_money",
      payload: { ...PAYLOAD, streaming: true, ...(display === undefined ? {} : { display }) },
    },
  });

  /** The turn as it stands mid-build: one settled host read, the make call
      still working, and the skeleton the card is showing for it. */
  const midBuild = (display?: "stage"): UIMessage => ({
    id: "msg_build",
    role: "assistant",
    parts: [
      doneTool("call_read", { transactions: new Array(6).fill({}) }),
      {
        type: "dynamic-tool",
        toolName: "vendo_make",
        toolCallId: "call_build",
        state: "input-available",
        input: { request: "where did my money go" },
      },
      forming(display),
    ] as unknown as UIMessage["parts"],
  });

  /** The same turn after the build failed: the make call errored, the last
      view part ever emitted is still the streaming skeleton, and the runtime's
      build-failed part plus the agent's own prose close the turn. */
  const deadBuild = (display?: "stage"): UIMessage => ({
    id: "msg_build",
    role: "assistant",
    parts: [
      doneTool("call_read", { transactions: new Array(6).fill({}) }),
      {
        type: "dynamic-tool",
        toolName: "vendo_make",
        toolCallId: "call_build",
        state: "output-error",
        input: { request: "where did my money go" },
        errorText: "app build failed: generation failed",
      },
      forming(display),
      {
        type: "data-vendo-build-failed",
        data: { toolCallId: "call_build", reason: "app build failed: generation failed" },
      },
      { type: "text", text: "I couldn't get that view to hold together, and nothing was changed." },
    ] as unknown as UIMessage["parts"],
  });

  function splitValue(overrides: Partial<SplitViewContextValue> = {}): SplitViewContextValue {
    return {
      expanded: false,
      featuredAppId: undefined,
      feature: vi.fn(),
      expandTo: vi.fn(),
      autoStage: vi.fn(),
      registerEmbed: vi.fn(),
      removeEmbed: vi.fn(),
      ...overrides,
    };
  }

  function turnTree(message: UIMessage, busy: boolean, value: SplitViewContextValue | null) {
    return (
      <VendoProvider>
        <SplitViewContext.Provider value={value}>
          <ThreadMessage
            message={message}
            restored={false}
            risks={new Map()}
            busy={busy}
            activeAssistantId={busy ? message.id : undefined}
            lastAssistantId={message.id}
            onEditLast={() => undefined}
            onRegenerateLast={() => undefined}
          />
        </SplitViewContext.Provider>
      </VendoProvider>
    );
  }

  // D1 over the window that actually matters: while the build runs the card bar
  // is the ONE narration of that step. The other call in the turn keeps its beat
  // — the suppression is aimed at the build, not at beats.
  it("narrates a running build exactly once — the card bar, never a beat beside it", () => {
    render(turnTree(midBuild(), true, null));
    const bar = document.querySelector(".fl-appcard-bar");
    expect(bar?.getAttribute("data-state")).toBe("building");
    expect(bar?.querySelector(".fl-boot-building")?.textContent).toContain("Building your view");
    // The build's beat must not exist DURING the build (the double-narration bug).
    expect(document.querySelector("[data-vendo-tool='vendo_make']")).toBeNull();
    expect(screen.queryByText(/Make you a screen/)).toBeNull();
    // Exactly one beat in the turn, and it belongs to the host read.
    const beats = document.querySelectorAll(".fl-beat");
    expect(beats).toHaveLength(1);
    expect(beats[0]?.getAttribute("data-vendo-tool")).toBe("host_list_transactions");
  });

  // §8 build calm applies to the SETTLED turn too: a dead build may not leave a
  // sweeping hairline or a skeleton behind. §15 says what replaces it — the ✕
  // beat and the agent's prose, no new furniture.
  it("clears the building card when the build dies: no hairline, no skeleton, just the ✕ and the prose", () => {
    render(turnTree(deadBuild(), false, null));
    expect(document.querySelector(".fl-appcard-bar")).toBeNull();
    expect(document.querySelector(".fl-boot-hairline")).toBeNull();
    expect(document.querySelector("[data-vendo-app-embed]")).toBeNull();
    expect(screen.queryByText(/Building your view/)).toBeNull();
    // ⚠️ TEST EDIT (M20): this asserted the failed BUILD's own ✕ beat, which
    // sat directly above the build-failed block's ✕ — one failure, two identical
    // ✕ lines in the same vocabulary. §15 wants the ✕ in the record, and the
    // block IS that record (it also says what the failure means for the reader).
    expect(document.querySelector("[data-vendo-tool='vendo_make']")).toBeNull();
    const failures = [...document.querySelectorAll(".fl-beat-error")];
    expect(failures).toHaveLength(1);
    expect(failures[0]?.closest("[data-vendo-build-failed]")).toBeTruthy();
    expect(document.body.textContent).toContain("nothing was changed");
    // No retry furniture grew in the process (§15).
    for (const button of Array.from(document.querySelectorAll("button"))) {
      expect(button.textContent ?? "", button.outerHTML).not.toMatch(/try again|re-?run|fix it/i);
    }
  });

  // The stage is the other half: it can only show an embed the split knows
  // about, so the dead skeleton has to be WITHDRAWN or the workspace sits on it
  // forever (the frame the E2E captured).
  it("takes the dead skeleton off the split view's stage too", () => {
    const value = splitValue({ expanded: true, featuredAppId: "app_money" });
    const { rerender } = render(turnTree(midBuild("stage"), true, value));
    expect(value.registerEmbed).toHaveBeenCalledWith("app_money", expect.objectContaining({ streaming: true }));
    expect(value.removeEmbed).not.toHaveBeenCalled();
    rerender(turnTree(deadBuild("stage"), false, value));
    expect(value.removeEmbed).toHaveBeenCalledWith("app_money");
  });

  // A live build is NOT a dead one: the card stays while the turn is still
  // working, even though the payload is streaming.
  it("leaves a still-running build's skeleton alone", () => {
    render(turnTree(midBuild(), true, null));
    expect(document.querySelector("[data-vendo-app-embed='app_money']")).toBeTruthy();
  });
});

/** M26 — the settled row's duration. A turn that was ALREADY RUNNING when this
 *  surface first saw it (a reopened conversation, a reload mid-turn) is both
 *  restored and pending, so the measured clock started when we arrived and the
 *  row understated a thirty-second turn as "· 1.2s". */
describe("the settled turn's duration (M26)", () => {
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

  const message = (state: "input-available" | "output-available"): UIMessage => ({
    id: "msg_clock",
    role: "assistant",
    parts: [{
      type: "dynamic-tool",
      toolName: "host_list_transactions",
      toolCallId: "call_1",
      state,
      input: {},
      ...(state === "output-available" ? { output: { rows: [] } } : {}),
    }],
  } as unknown as UIMessage);

  const view = (state: "input-available" | "output-available", restored: boolean) => (
    <VendoProvider client={client}>
      <ThreadMessage
        message={message(state)}
        restored={restored}
        risks={new Map()}
        busy={false}
        onEditLast={() => undefined}
        onRegenerateLast={() => undefined}
      />
    </VendoProvider>
  );

  it("shows the count ALONE when the turn was already running before we arrived", () => {
    const { rerender } = render(view("input-available", true));
    // Still working: nothing folded yet.
    expect(document.querySelector(".fl-beatsummary")).toBeNull();
    rerender(view("output-available", true));
    expect(document.querySelector(".fl-beatsummary")?.textContent).toBe("Did 1 thing");
  });

  it("still measures a turn it watched start", () => {
    const { rerender } = render(view("input-available", false));
    rerender(view("output-available", false));
    expect(document.querySelector(".fl-beatsummary")?.textContent)
      .toMatch(/^Did 1 thing · \d+\.\d+s$/);
  });
});

/**
 * The turn's hover actions, across all four states a turn can be in — and the
 * mark on a beat that is parked on the person.
 *
 * The defect: the actions were gated on the broad "any call not settled yet",
 * which is ALSO true of a call abandoned by Stop (nothing reconciles an aborted
 * call out of `input-available`). So stopping mid-call took Copy and Regenerate
 * off the last turn permanently — the two controls a person reaches for right
 * after stopping. The gate is the PARKED ask, which is the thing the row was
 * actually standing down for.
 */
describe("the turn's actions in every turn state", () => {
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

  const TURN = "msg_actions";
  const message = (state: "input-available" | "approval-requested" | "output-available"): UIMessage => ({
    id: TURN,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "host_send_payment",
        toolCallId: "call_1",
        state,
        input: { amount_cents: 4750 },
        ...(state === "output-available" ? { output: { ok: true } } : {}),
        ...(state === "approval-requested" ? { approval: { id: "apr_1" } } : {}),
      },
      { type: "text", text: "Here's the transfer." },
    ],
  } as unknown as UIMessage);

  const show = (state: "input-available" | "approval-requested" | "output-available", busy: boolean) =>
    render(
      <VendoProvider client={client}>
        <ThreadMessage
          message={message(state)}
          restored={false}
          risks={new Map()}
          busy={busy}
          activeAssistantId={busy ? TURN : undefined}
          lastAssistantId={TURN}
          onEditLast={() => undefined}
          onRegenerateLast={() => undefined}
        />
      </VendoProvider>,
    );

  const actions = () => document.querySelector(".fl-turn-actions");

  it("STREAMING: no actions while the turn's text is still arriving", () => {
    show("input-available", true);
    expect(actions()).toBeNull();
  });

  it("PARKED on a consent ask: no actions, and the beat above the card turns", () => {
    show("approval-requested", false);
    // The row is not merely invisible on the last turn (chrome-css reveals it
    // there without a hover) — it would sit between the beat and the card.
    expect(actions()).toBeNull();
    // Nothing on our side is moving while we wait on a person, so the beat's
    // orb becomes the launcher's indeterminate arc.
    expect(document.querySelector(".fl-beat-orb.fl-beat-ring")).toBeTruthy();
    expect(document.querySelector(".fl-beat")!.textContent).toContain("waiting for your approval");
  });

  it("STOPPED mid-call: Copy and Regenerate come straight back", () => {
    // Not busy, but the aborted call still reads `input-available` forever.
    show("input-available", false);
    expect(actions()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    // A working beat keeps its still orb; only a parked one turns.
    expect(document.querySelector(".fl-beat-ring")).toBeNull();
  });

  it("SETTLED: the full row, unchanged", () => {
    show("output-available", false);
    expect(actions()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeTruthy();
    expect(document.querySelector(".fl-beat-ring")).toBeNull();
  });
});

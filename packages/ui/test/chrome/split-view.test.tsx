// @vitest-environment jsdom
// 2026-07 demo feedback — the overlay's expandable split-view workspace.
// The pure state machine (split-view.tsx) is unit-tested first; the component
// tests then pin the overlay behaviors: expand/collapse without a thread
// remount, feature selection from the rail, the Escape order (collapse first,
// close second), and the subtle expand suggestion when an embed lands.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type Thread, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoThread, type VendoThreadProps } from "../../src/chrome/index.js";
import {
  escapeIntent,
  expandedStageRect,
  featuredEmbed,
  initialSplitViewState,
  splitViewReducer,
  useSplitView,
  type SplitViewState,
} from "../../src/chrome/split-view.js";
import { createWireServer } from "../wire-server.js";

describe("splitViewReducer (state machine)", () => {
  const embed = (appId: string, note = appId) => ({ type: "embed" as const, appId, payload: { note } });

  it("expands and collapses idempotently", () => {
    let state = initialSplitViewState;
    state = splitViewReducer(state, { type: "expand" });
    expect(state.expanded).toBe(true);
    expect(splitViewReducer(state, { type: "expand" })).toBe(state); // no-op keeps identity
    state = splitViewReducer(state, { type: "collapse" });
    expect(state.expanded).toBe(false);
    expect(splitViewReducer(state, { type: "collapse" })).toBe(state);
    expect(splitViewReducer(state, { type: "toggle" }).expanded).toBe(true);
  });

  it("features the LATEST embed by default and follows new arrivals", () => {
    let state = splitViewReducer(initialSplitViewState, embed("app_a"));
    expect(featuredEmbed(state)?.appId).toBe("app_a");
    state = splitViewReducer(state, embed("app_b"));
    expect(featuredEmbed(state)?.appId).toBe("app_b");
  });

  it("an explicit pick wins over recency and survives later arrivals", () => {
    let state = splitViewReducer(initialSplitViewState, embed("app_a"));
    state = splitViewReducer(state, embed("app_b"));
    state = splitViewReducer(state, { type: "feature", appId: "app_a" });
    expect(featuredEmbed(state)?.appId).toBe("app_a");
    state = splitViewReducer(state, embed("app_c"));
    expect(featuredEmbed(state)?.appId).toBe("app_a");
  });

  it("records featuring an app the thread has not embedded, and stages nothing rather than another app", () => {
    const state = splitViewReducer(initialSplitViewState, embed("app_a"));
    const picked = splitViewReducer(state, { type: "feature", appId: "app_zz" });
    expect(picked.selectedAppId).toBe("app_zz");
    expect(featuredEmbed(picked)).toBeUndefined();
  });

  it("re-registering an app updates its payload in place (no reorder)", () => {
    let state = splitViewReducer(initialSplitViewState, embed("app_a", "v1"));
    state = splitViewReducer(state, embed("app_b"));
    state = splitViewReducer(state, embed("app_a", "v2"));
    expect(state.embeds.map(entry => entry.appId)).toEqual(["app_a", "app_b"]);
    expect((state.embeds[0]!.payload as { note: string }).note).toBe("v2");
    // Recency still favors app_b — the update did not jump the queue.
    expect(featuredEmbed(state)?.appId).toBe("app_b");
  });

  it("removing the explicit pick falls back to the latest remaining embed", () => {
    let state = splitViewReducer(initialSplitViewState, embed("app_a"));
    state = splitViewReducer(state, embed("app_b"));
    state = splitViewReducer(state, { type: "feature", appId: "app_a" });
    state = splitViewReducer(state, { type: "remove-embed", appId: "app_a" });
    expect(state.selectedAppId).toBeUndefined();
    expect(featuredEmbed(state)?.appId).toBe("app_b");
    state = splitViewReducer(state, { type: "remove-embed", appId: "app_b" });
    expect(featuredEmbed(state)).toBeUndefined();
  });

  it("a failed staged build takes its stage with it; a workspace the USER opened stays", () => {
    // The build's own stage: opened by the hint, so when the embed withdraws
    // (M21 — a failed build) the panel collapses instead of sitting expanded
    // over an empty stage.
    let auto = splitViewReducer(initialSplitViewState, embed("app_a"));
    auto = splitViewReducer(auto, { type: "expand", auto: true });
    expect(auto.expanded).toBe(true);
    auto = splitViewReducer(auto, { type: "remove-embed", appId: "app_a" });
    expect(auto.embeds).toEqual([]);
    expect(auto.expanded).toBe(false);

    // Two staged views: losing one is not losing the stage.
    let two = splitViewReducer(initialSplitViewState, embed("app_a"));
    two = splitViewReducer(two, embed("app_b"));
    two = splitViewReducer(two, { type: "expand", auto: true });
    two = splitViewReducer(two, { type: "remove-embed", appId: "app_a" });
    expect(two.expanded).toBe(true);

    // The user's own workspace is theirs to close — even empty.
    let mine = splitViewReducer(initialSplitViewState, embed("app_a"));
    mine = splitViewReducer(mine, { type: "expand" });
    mine = splitViewReducer(mine, { type: "remove-embed", appId: "app_a" });
    expect(mine.expanded).toBe(true);
    // …and a user Expand over an auto-opened stage upgrades it to theirs.
    let upgraded = splitViewReducer(initialSplitViewState, embed("app_a"));
    upgraded = splitViewReducer(upgraded, { type: "expand", auto: true });
    upgraded = splitViewReducer(upgraded, { type: "expand" });
    upgraded = splitViewReducer(upgraded, { type: "remove-embed", appId: "app_a" });
    expect(upgraded.expanded).toBe(true);
  });

  it("expandedStageRect mirrors the chrome-css split-view constants (the FLIP ghost's target)", async () => {
    // 1440×1100 viewport: panel = min(1500, .96·1440)=1382.4 × min(940, .94·1100)=940,
    // centered; rail = max(360, .335·(1382.4−2)) on the LEFT; stage pane = the
    // rest inside the border, starting past the rail.
    const rect = expandedStageRect({ width: 1440, height: 1100 });
    const panelW = Math.min(1500, 1440 * 0.96);
    const panelH = Math.min(940, 1100 * 0.94);
    const rail = Math.max(360, (panelW - 2) * 0.335);
    expect(rect.left).toBeCloseTo((1440 - panelW) / 2 + 1 + rail, 5);
    expect(rect.top).toBeCloseTo((1100 - panelH) / 2 + 1, 5);
    expect(rect.width).toBeCloseTo(panelW - 2 - rail, 5);
    expect(rect.height).toBeCloseTo(panelH - 2, 5);
    // Small viewport: the 360px rail floor holds.
    const small = expandedStageRect({ width: 900, height: 700 });
    expect(small.width).toBeCloseTo(900 * 0.96 - 2 - 360, 5);
    expect(small.left).toBeCloseTo((900 - 900 * 0.96) / 2 + 1 + 360, 5);
    // And the constants the math mirrors are still the ones the stylesheet ships.
    const { CHROME_CSS } = await import("../../src/chrome/chrome-css.js");
    expect(CHROME_CSS).toContain("width: min(1500px, 96vw); height: min(940px, 94vh);");
    expect(CHROME_CSS).toContain("--vendo-rail-w: max(360px, 33.5%);");
  });

  it("the plan hint's auto-stage shot is recorded ONCE per BUILD, open or not (G1)", () => {
    // ⚠️ FIXTURE/KEY CHANGE (ruling 23): the ledger is keyed by BUILD — the
    // turn's own view part — not by app id. Every G1 assertion below is
    // unchanged in substance; the keys are build keys now.
    let state = splitViewReducer(initialSplitViewState, embed("app_a"));
    state = splitViewReducer(state, { type: "auto-stage", buildKey: "msg_1-0-app_a" });
    expect(state.autoStaged).toEqual(["msg_1-0-app_a"]);
    // A repeat for the same build changes nothing (identity kept = no re-render).
    expect(splitViewReducer(state, { type: "auto-stage", buildKey: "msg_1-0-app_a" })).toBe(state);
    // A SECOND staged view records its own shot even though the workspace is
    // already open — this is the record that used to be skipped, so the first
    // Back-to-chat re-opened the panel.
    state = splitViewReducer(state, { type: "expand" });
    state = splitViewReducer(state, { type: "auto-stage", buildKey: "msg_1-1-app_b" });
    expect(state.autoStaged).toEqual(["msg_1-0-app_a", "msg_1-1-app_b"]);
    expect(splitViewReducer(state, { type: "auto-stage", buildKey: "msg_1-1-app_b" })).toBe(state);
    // And the ledger survives the collapse: neither hint is armed again.
    state = splitViewReducer(state, { type: "collapse" });
    expect(splitViewReducer(state, { type: "auto-stage", buildKey: "msg_1-0-app_a" })).toBe(state);
    expect(splitViewReducer(state, { type: "auto-stage", buildKey: "msg_1-1-app_b" })).toBe(state);
  });

  it("RULING 23 — a NEW build of the SAME app gets its own shot after a collapse", () => {
    // The unwritten cost of an app-keyed ledger: once the user had collapsed a
    // stage, an EXPLICIT new build request for that app never staged again. G1
    // forbids the UI opening ITSELF; honouring a fresh request is not that.
    let state = splitViewReducer(initialSplitViewState, embed("app_a"));
    state = splitViewReducer(state, { type: "auto-stage", buildKey: "msg_1-0-app_a" });
    state = splitViewReducer(state, { type: "expand" });
    state = splitViewReducer(state, { type: "collapse" });
    // Same build, still spent — Back-to-chat is final for the build in hand.
    expect(splitViewReducer(state, { type: "auto-stage", buildKey: "msg_1-0-app_a" })).toBe(state);
    // A new turn's build of the same app is a fresh, asked-for request.
    const next = splitViewReducer(state, { type: "auto-stage", buildKey: "msg_2-0-app_a" });
    expect(next).not.toBe(state);
    expect(next.autoStaged).toEqual(["msg_1-0-app_a", "msg_2-0-app_a"]);
  });

  it("Escape order: collapse while expanded, close otherwise", () => {
    const collapsed: SplitViewState = initialSplitViewState;
    const expanded = splitViewReducer(collapsed, { type: "expand" });
    expect(escapeIntent(expanded)).toBe("collapse");
    expect(escapeIntent(collapsed)).toBe("close");
    expect(escapeIntent(splitViewReducer(expanded, { type: "collapse" }))).toBe("close");
  });
});

describe("VendoOverlay split view", () => {
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

  const dialogQuery = () => screen.queryByRole("dialog", { name: "Vendo assistant" });
  const expandButton = () => screen.getByRole("button", { name: "Expand workspace" });

  /**
   * The H9 chain's MIDDLE — `vendo-overlay.tsx`'s `autoStage` closure over
   * `splitStateRef`, the code that actually decides whether the panel opens.
   * The post-check found it mocked in both unit tests and exercised for real
   * nowhere. This drives it through the real provider: a probe mounted as the
   * overlay's thread calls the context's own `autoStage`, exactly as
   * `ThreadAppCard`'s effect does.
   */
  it("H9 + ruling 23 — Back-to-chat is final for a build, and a NEW build still stages", async () => {
    const Probe = () => {
      const split = useSplitView();
      return (
        <div>
          <button type="button" onClick={() => split?.autoStage("app_first", "msg_1-0-app_first")}>stage build one</button>
          <button type="button" onClick={() => split?.autoStage("app_first", "msg_2-0-app_first")}>stage build two</button>
        </div>
      );
    };
    render(
      <VendoProvider client={client}>
        <VendoOverlay defaultOpen thread={Probe as unknown as (props: VendoThreadProps) => React.JSX.Element} />
      </VendoProvider>,
    );
    const dialog = dialogQuery()!;
    expect(dialog.hasAttribute("data-vendo-expanded")).toBe(false);

    // The plan hint opens the stage for the build in hand.
    fireEvent.click(screen.getByRole("button", { name: "stage build one" }));
    await waitFor(() => expect(dialog.hasAttribute("data-vendo-expanded")).toBe(true));

    // Back to chat. §2 G1: this build's hint is spent — it may not re-open.
    fireEvent.click(screen.getByRole("button", { name: "Collapse workspace" }));
    expect(dialog.hasAttribute("data-vendo-expanded")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "stage build one" }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(dialog.hasAttribute("data-vendo-expanded")).toBe(false);

    // A NEW build of the SAME app is a fresh, asked-for request, and it stages.
    fireEvent.click(screen.getByRole("button", { name: "stage build two" }));
    await waitFor(() => expect(dialog.hasAttribute("data-vendo-expanded")).toBe(true));
  });

  it("expands into the workspace and collapses back, WITHOUT remounting the thread", async () => {
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    const dialog = dialogQuery()!;
    expect(dialog.hasAttribute("data-vendo-expanded")).toBe(false);

    // The composer carries un-sent state across the flip — the remount canary.
    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "draft survives the flip" } });

    fireEvent.click(expandButton());
    expect(dialog.hasAttribute("data-vendo-expanded")).toBe(true);
    // No embeds yet: the stage shows its quiet empty state.
    expect(screen.getByText("Views you build land here.")).toBeTruthy();
    // Same textarea element, same draft — the conversation never remounted.
    const after = screen.getByRole("textbox", { name: "Message" });
    expect(after).toBe(composer);
    expect((after as HTMLTextAreaElement).value).toBe("draft survives the flip");

    fireEvent.click(screen.getByRole("button", { name: "Collapse workspace" }));
    expect(dialog.hasAttribute("data-vendo-expanded")).toBe(false);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(composer);
  });

  it("Escape collapses the expanded workspace first and closes the overlay second", async () => {
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    const dialog = dialogQuery()!;
    fireEvent.click(expandButton());
    expect(dialog.hasAttribute("data-vendo-expanded")).toBe(true);

    fireEvent.keyDown(dialog, { key: "Escape" });
    // First Escape: still open, no longer expanded.
    expect(dialogQuery()).toBeTruthy();
    expect(dialog.hasAttribute("data-vendo-expanded")).toBe(false);

    fireEvent.keyDown(dialog, { key: "Escape" });
    // Second Escape: the overlay closes (uncontrolled mode hides the portal).
    expect(dialogQuery()).toBeNull();
  });

  /** A stored thread carrying two finished app embeds, adopted via a custom
   *  Thread component (the overlay's `thread` prop). */
  function embedsFixture(): { thread: Thread; ThreadWithEmbeds: (props: VendoThreadProps) => React.JSX.Element } {
    const NOW = "2026-07-22T12:00:00.000Z";
    const view = (appId: string, name: string) => ({
      type: "data-vendo-view",
      data: {
        appId,
        payload: {
          formatVersion: "vendo-genui/v2",
          name,
          root: "root",
          nodes: [
            { id: "root", component: "Stack", children: ["note"] },
            { id: "note", component: "Text", props: { text: `${name} body` } },
          ],
        },
      },
    });
    const thread = {
      id: "thr_split",
      subject: "browser-user",
      createdAt: NOW,
      updatedAt: NOW,
      messages: [{
        id: "msg_views",
        role: "assistant",
        parts: [view("app_first", "Spending radar"), view("app_second", "Goals board")],
      }],
    } as unknown as Thread;
    const ThreadWithEmbeds = (props: VendoThreadProps) => <VendoThread {...props} threadId="thr_split" />;
    return { thread, ThreadWithEmbeds };
  }

  function threadClient(thread: Thread): VendoClient {
    return {
      ...client,
      threads: {
        ...client.threads,
        get: async id => (id === thread.id ? thread : client.threads.get(id)),
        list: async () => [{ id: thread.id, title: thread.subject, updatedAt: thread.updatedAt }],
      },
    };
  }

  it("features the LATEST embed on the stage; clicking a rail embed features it instead", async () => {
    const { thread, ThreadWithEmbeds } = embedsFixture();
    render(
      <VendoProvider client={threadClient(thread)}>
        <VendoOverlay defaultOpen thread={ThreadWithEmbeds} />
      </VendoProvider>,
    );
    // Both cards land in the rail…
    await screen.findAllByText("Spending radar body");
    // …and a fresh embed while collapsed suggests expanding (subtle pulse attr).
    await waitFor(() => expect(expandButton().hasAttribute("data-vendo-suggest")).toBe(true));

    fireEvent.click(expandButton());
    // Expanding clears the suggestion and stages the MOST RECENT embed.
    expect(screen.getByRole("button", { name: "Collapse workspace" }).hasAttribute("data-vendo-suggest")).toBe(false);
    const stage = document.querySelector(".fl-stage")!;
    expect(within(stage as HTMLElement).getByText("Goals board")).toBeTruthy();

    // The rail marks the featured card; clicking the OTHER card features it.
    const firstCard = document.querySelector(".fl-appcard[data-vendo-featurable]:not([data-vendo-featured])")!;
    expect(firstCard.textContent).toContain("Spending radar");
    fireEvent.click(within(firstCard as HTMLElement).getByRole("button", { name: "Show this view in the workspace" }));
    await waitFor(() => {
      const stageNow = document.querySelector(".fl-stage")!;
      expect(within(stageNow as HTMLElement).getByText("Spending radar")).toBeTruthy();
    });
    // The explicit pick survives collapse/expand round-trips.
    fireEvent.click(screen.getByRole("button", { name: "Collapse workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand workspace" }));
    expect(within(document.querySelector(".fl-stage") as HTMLElement).getByText("Spending radar")).toBeTruthy();
  });

  it("compact preview: overlay cards render the scaled canvas with a prominent Expand pill; Expand stages the app", async () => {
    const { thread, ThreadWithEmbeds } = embedsFixture();
    render(
      <VendoProvider client={threadClient(thread)}>
        <VendoOverlay defaultOpen thread={ThreadWithEmbeds} />
      </VendoProvider>,
    );
    await screen.findAllByText("Spending radar body");
    // Compact mode (collapsed overlay): both cards are inert scaled previews…
    const previews = document.querySelectorAll(".fl-appcard-preview");
    expect(previews.length).toBe(2);
    expect(document.querySelectorAll(".fl-appcard-canvas").length).toBe(2);
    // …with the prominent Expand affordance on each.
    const expandPills = screen.getAllByRole("button", { name: "Expand this view" });
    expect(expandPills.length).toBe(2);

    // Expanding via the FIRST card's pill stages THAT app (not the latest).
    fireEvent.click(expandPills[0]!);
    const dialog = dialogQuery()!;
    expect(dialog.hasAttribute("data-vendo-expanded")).toBe(true);
    const stage = document.querySelector(".fl-stage")!;
    expect(within(stage as HTMLElement).getByText("Spending radar")).toBeTruthy();
    // The stage keeps FULL size — no preview scaling inside it.
    expect(stage.querySelector(".fl-appcard-canvas")).toBeNull();
  });

  it("staged = blurred in chat: the featured card shows the Full screened veil; collapse clears it", async () => {
    const { thread, ThreadWithEmbeds } = embedsFixture();
    render(
      <VendoProvider client={threadClient(thread)}>
        <VendoOverlay defaultOpen thread={ThreadWithEmbeds} />
      </VendoProvider>,
    );
    await screen.findAllByText("Spending radar body");
    fireEvent.click(expandButton());
    // The latest embed (Goals board) is staged: its rail card blurs under the
    // centered label; the other card stays a plain preview.
    const staged = document.querySelector(".fl-appcard-preview[data-vendo-staged]")!;
    expect(staged).toBeTruthy();
    expect(within(staged as HTMLElement).getByText("Full screened")).toBeTruthy();
    expect(document.querySelectorAll(".fl-appcard-preview[data-vendo-staged]").length).toBe(1);
    // The staged card's Expand pill stands down (the veil owns the surface).
    expect(within(staged as HTMLElement).queryByRole("button", { name: "Expand this view" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Collapse workspace" }));
    expect(document.querySelector(".fl-appcard-preview[data-vendo-staged]")).toBeNull();
    expect(screen.queryByText("Full screened")).toBeNull();
  });

  it("pin from fullscreen: the stage bar's Pin to dashboard fires onPin and CLOSES the whole overlay", async () => {
    const { thread, ThreadWithEmbeds } = embedsFixture();
    const onPin = vi.fn();
    render(
      <VendoProvider client={threadClient(thread)} onPin={onPin}>
        <VendoOverlay defaultOpen thread={ThreadWithEmbeds} />
      </VendoProvider>,
    );
    await screen.findAllByText("Spending radar body");
    fireEvent.click(expandButton());
    const stage = document.querySelector(".fl-stage")!;
    fireEvent.click(within(stage as HTMLElement).getByRole("button", { name: "Pin to dashboard" }));
    expect(onPin).toHaveBeenCalledWith(expect.objectContaining({ appId: "app_second" }));
    // Closed — not just collapsed — so the user lands back in the product.
    expect(dialogQuery()).toBeNull();
  });

  /** What staged app cards do to the workspace, as parts.tsx will call it: the
   *  hint fires from an effect that re-runs whenever the split context changes
   *  identity — which is exactly what a collapse does. The second app arrives a
   *  commit LATER (as a second card in the turn does), while the workspace the
   *  first one opened is already up. */
  function StageHint({ appIds }: { appIds: string[] }) {
    const split = useSplitView();
    const [arrived, setArrived] = useState(1);
    useEffect(() => {
      const timer = setTimeout(() => setArrived(appIds.length), 0);
      return () => clearTimeout(timer);
    }, [appIds]);
    useEffect(() => {
      if (split === null) return;
      // Build keys as parts.tsx forms them: `${message.id}-${index}-${appId}`.
      for (const [index, appId] of appIds.slice(0, arrived).entries()) split.autoStage(appId, `msg_1-${index}-${appId}`);
    }, [split, appIds, arrived]);
    return null;
  }

  it("autoStage: the stage hint opens the workspace ONCE and Back-to-chat is final (§2 G1)", async () => {
    const { thread, ThreadWithEmbeds } = embedsFixture();
    const staged = ["app_first", "app_second"];
    const ThreadWithHint = (props: VendoThreadProps) => (
      <>
        <ThreadWithEmbeds {...props} />
        <StageHint appIds={staged} />
      </>
    );
    render(
      <VendoProvider client={threadClient(thread)}>
        <VendoOverlay defaultOpen thread={ThreadWithHint} />
      </VendoProvider>,
    );
    const dialog = dialogQuery()!;
    // The hint staged the view on arrival (V4: the stage opens at build start),
    // and the SECOND staged view spends its shot a commit later against the
    // already-open workspace — the record H9 skipped.
    await waitFor(() => expect(dialog.hasAttribute("data-vendo-expanded")).toBe(true));
    await screen.findAllByText("Spending radar body");

    // Back-to-chat. Both hints' effects re-run on the collapse (the split
    // context changed identity) and neither may re-open the panel.
    fireEvent.click(screen.getByRole("button", { name: "Collapse workspace" }));
    expect(dialog.hasAttribute("data-vendo-expanded")).toBe(false);
    await waitFor(() => expect(screen.getByRole("button", { name: "Expand workspace" })).toBeTruthy());
    expect(dialog.hasAttribute("data-vendo-expanded")).toBe(false);

    // The user is never blocked by the ledger: their own Expand still works.
    fireEvent.click(screen.getByRole("button", { name: "Expand workspace" }));
    expect(dialog.hasAttribute("data-vendo-expanded")).toBe(true);
  });

  it("ships the split-view rules in the chrome stylesheet (reduced-motion snaps included)", async () => {
    const { CHROME_CSS } = await import("../../src/chrome/chrome-css.js");
    expect(CHROME_CSS).toContain(".fl-split-rail");
    expect(CHROME_CSS).toContain(".fl-overlay-panel[data-vendo-expanded]");
    expect(CHROME_CSS).toContain("max(360px, 33.5%)");
    // Reduced motion: the pane slide snaps.
    expect(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.fl-split-rail, \.fl-split-stage \{ transition: none; \}/.test(CHROME_CSS)).toBe(true);
  });
});

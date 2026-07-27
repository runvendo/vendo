// @vitest-environment jsdom
// 2026-07 demo feedback — the overlay's expandable split-view workspace.
// The pure state machine (split-view.tsx) is unit-tested first; the component
// tests then pin the overlay behaviors: expand/collapse without a thread
// remount, feature selection from the rail, the Escape order (collapse first,
// close second), and the subtle expand suggestion when an embed lands.
import type { Thread } from "@vendoai/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoThread, type VendoThreadProps } from "../../src/chrome/index.js";
import {
  escapeIntent,
  expandedStageRect,
  featuredEmbed,
  initialSplitViewState,
  splitViewReducer,
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

  it("ignores featuring an unknown app", () => {
    const state = splitViewReducer(initialSplitViewState, embed("app_a"));
    expect(splitViewReducer(state, { type: "feature", appId: "app_zz" })).toBe(state);
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

  it("expandedStageRect mirrors the chrome-css split-view constants (the FLIP ghost's target)", async () => {
    // 1440×1100 viewport: panel = min(1500, .96·1440)=1382.4 × min(940, .94·1100)=940,
    // centered; rail = max(360, .335·(1382.4−2)); stage pane = the rest inside the border.
    const rect = expandedStageRect({ width: 1440, height: 1100 });
    const panelW = Math.min(1500, 1440 * 0.96);
    const panelH = Math.min(940, 1100 * 0.94);
    const rail = Math.max(360, (panelW - 2) * 0.335);
    expect(rect.left).toBeCloseTo((1440 - panelW) / 2 + 1, 5);
    expect(rect.top).toBeCloseTo((1100 - panelH) / 2 + 1, 5);
    expect(rect.width).toBeCloseTo(panelW - 2 - rail, 5);
    expect(rect.height).toBeCloseTo(panelH - 2, 5);
    // Small viewport: the 360px rail floor holds.
    const small = expandedStageRect({ width: 900, height: 700 });
    expect(small.width).toBeCloseTo(900 * 0.96 - 2 - 360, 5);
    // And the constants the math mirrors are still the ones the stylesheet ships.
    const { CHROME_CSS } = await import("../../src/chrome/chrome-css.js");
    expect(CHROME_CSS).toContain("width: min(1500px, 96vw); height: min(940px, 94vh);");
    expect(CHROME_CSS).toContain("flex-basis: max(360px, 33.5%);");
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
   *  Thread component (the overlay's eject seam). */
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

  it("ships the split-view rules in the chrome stylesheet (reduced-motion snaps included)", async () => {
    const { CHROME_CSS } = await import("../../src/chrome/chrome-css.js");
    expect(CHROME_CSS).toContain(".fl-split-rail");
    expect(CHROME_CSS).toContain(".fl-overlay-panel[data-vendo-expanded]");
    expect(CHROME_CSS).toContain("max(360px, 33.5%)");
    // Reduced motion: the pane slide snaps.
    expect(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.fl-split-rail, \.fl-split-stage \{ transition: none; \}/.test(CHROME_CSS)).toBe(true);
  });
});

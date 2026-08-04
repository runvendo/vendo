// @vitest-environment jsdom
/**
 * The AI center (redesign spec §10 X1 / §12 page-inside-host-app / §14 cold
 * start): VendoPage is no longer five tabs over a card — it is an in-page rail
 * (New chat · Apps · Automations · Needs-you · chats) beside one column.
 *
 * What this file pins is the SHELL's behavior, the part a restyle must not
 * quietly lose:
 *  - the rail carries no brand row and no user row (§12: the host's app is the
 *    frame; we never bring an app shell of our own);
 *  - "Needs you" exists ONLY while asks are waiting, with the count on it;
 *  - the home shelf is ghost tiles at zero apps (§14 CS2) and live tiles once
 *    an app exists;
 *  - conversations group by recency;
 *  - the section switcher keeps real tab semantics (roving focus, one selected
 *    tab, a labelled panel) — §13 strangers means nothing here reaches for the
 *    overlay.
 */
import { readFileSync } from "node:fs";
import type { ApprovalRequest, AppDocument } from "@vendoai/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, type VendoClient } from "../../src/index.js";
import { VendoPage } from "../../src/chrome/index.js";
import { markSeen } from "../../src/chrome/discoverability.js";
import { publishThreadRun, resetRunActivity } from "../../src/chrome/run-activity.js";
import type { ThreadSummary } from "../../src/wire-types.js";

const DAY_MS = 86_400_000;
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

function appDoc(id: string, name: string): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name,
    ui: "tree",
    tree: {
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [
        { id: "root", component: "Stack", children: ["label", "act"] },
        { id: "label", component: "Text", props: { text: `${name} app surface` } },
        // A real generated view has its own interactive furniture — the reason a
        // tile preview cannot simply be aria-hidden.
        { id: "act", component: "Button", props: { label: "Pay now", action: "pay" } },
      ],
    },
  } as AppDocument;
}

function ask(id: string, tool = "host_email_send"): ApprovalRequest {
  return {
    id,
    call: { id: `call_${id}`, tool, args: { to: "a@example.com" } },
    descriptor: { name: tool, description: "Send email", inputSchema: { type: "object" }, risk: "write" },
    inputPreview: "to a@example.com",
    ctx: { principal: { kind: "user", subject: "user_1" }, venue: "chat", presence: "present" },
    createdAt: iso(60_000),
  } as ApprovalRequest;
}

/** A client with no server behind it: every read the center makes, stubbed. */
function stubClient(over: {
  threads?: ThreadSummary[];
  apps?: AppDocument[];
  pending?: () => ApprovalRequest[];
  /** Every app read this client is asked for, in order (H16 boot accounting). */
  log?: string[];
  /** Every `apps.open` fails, the way a dead app machine fails. */
  openFails?: boolean;
} = {}): VendoClient {
  const apps = over.apps ?? [];
  const pending = over.pending ?? (() => []);
  const log = over.log ?? [];
  return {
    baseUrl: "http://vendo.test",
    headers: {},
    async status() { return { posture: "unconfigured", version: "test", blocks: {} }; },
    threads: {
      async list() { return over.threads ?? []; },
      async get(id: string) { return { id, subject: "user_1", messages: [], createdAt: iso(0), updatedAt: iso(0) }; },
      async delete() { return undefined; },
    },
    apps: {
      async list() { return apps; },
      async get(id: string) {
        log.push(`get:${id}`);
        return apps.find(app => app.id === id) ?? apps[0]!;
      },
      async open(id: string) {
        log.push(`open:${id}`);
        if (over.openFails === true) throw Object.assign(new Error(`app ${id} has no machine: VENDO_API_KEY unset`), { code: "cloud-required" });
        const app = apps.find(item => item.id === id) ?? apps[0]!;
        return { kind: "tree", payload: (app as { tree: unknown }).tree };
      },
      async create() { return apps[0]!; },
      async delete() { return undefined; },
      async fork() { return apps[0]!; },
      async edit() { return { app: apps[0]! }; },
      async pingMachine() { return undefined; },
    },
    approvals: {
      async pending() { return pending(); },
      async decide() { return { decided: [] }; },
    },
    automations: { async list() { return []; } },
    runs: { async list() { return { runs: [] }; } },
    grants: { async list() { return []; } },
    connections: { async list() { return []; }, async catalog() { return []; } },
    activity: { async list() { return []; } },
  } as unknown as VendoClient;
}

const mount = (client: VendoClient) =>
  render(<VendoProvider client={client}><VendoPage /></VendoProvider>);

beforeEach(() => {
  window.localStorage.clear();
  // The one-time greeting-as-tutorial is its own surface (discoverability §6);
  // these cases are about the shell around it.
  markSeen("greeting");
});
afterEach(cleanup);

describe("the center rail", () => {
  it("is an in-page rail: the named doors, no brand row, no user row", async () => {
    mount(stubClient());
    const tabs = await screen.findByRole("tablist", { name: "Workspace sections" });
    expect(tabs.getAttribute("aria-orientation")).toBe("vertical");
    // ⚠️ TEST EDIT — "New chat" is no longer a TAB. It is an act (it discards
    // the open conversation and its draft), so it is a plain button ABOVE the
    // tablist; only real views are tabs.
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(within(tabs).queryByRole("tab", { name: "New chat" })).toBeNull();
    for (const name of ["Apps", "Automations"]) {
      expect(within(tabs).getByRole("tab", { name })).toBeTruthy();
    }
    // §12 — the host's app supplies its own chrome: we bring neither identity
    // nor an account row.
    expect(screen.queryByRole("tab", { name: "Chat" })).toBeNull();
    expect(screen.queryByText(/signed in|account|user_1/i)).toBeNull();
    // §13 — strangers: nothing in the center offers to hand off to the overlay.
    expect(screen.queryByText(/open in assistant/i)).toBeNull();
  });

  it("moves Activity and Accounts under the quiet ··· row, opening the existing panels", async () => {
    mount(stubClient());
    await screen.findByRole("tablist", { name: "Workspace sections" });
    expect(screen.queryByRole("tab", { name: "Activity" })).toBeNull();
    const more = screen.getByRole("button", { name: "More sections" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("heading", { name: "Activity" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Accounts" }));
    expect(await screen.findByRole("heading", { name: "Connected accounts" })).toBeTruthy();
  });

  // ⚠️ TEST EDIT — APG AUTOMATIC activation. This asserted MANUAL activation
  // (arrows move focus, Enter chooses), which the rail only needed because an
  // ACT sat inside the tablist: an arrow that selected as it passed "New chat"
  // threw the user's draft away (H18). The act is out of the list now, every
  // remaining row is a view whose panel appears instantly, and selection
  // follows focus — which is what a tablist that reports a selection at all
  // has to do.
  it("selection follows the arrow keys, and the panel is labelled by the selected tab", async () => {
    mount(stubClient());
    const apps = await screen.findByRole("tab", { name: "Apps" });
    const automations = screen.getByRole("tab", { name: "Automations" });
    fireEvent.click(apps);
    expect(apps.getAttribute("aria-selected")).toBe("true");
    expect(apps.getAttribute("tabindex")).toBe("0");
    expect(automations.getAttribute("tabindex")).toBe("-1");
    apps.focus();
    fireEvent.keyDown(apps, { key: "ArrowDown" });
    // Focus moved AND the selection moved with it, and the roving stop follows.
    expect(document.activeElement).toBe(automations);
    expect(automations.getAttribute("aria-selected")).toBe("true");
    expect(automations.getAttribute("tabindex")).toBe("0");
    expect(apps.getAttribute("aria-selected")).toBe("false");
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(automations.getAttribute("id"));
  });

  // ⚠️ TEST EDIT — H18 is now STRUCTURAL, so this proves the structure instead
  // of the keyboard handler's memory. The arrow keys cannot start a new chat
  // because "New chat" is not in the tablist they walk; wrapping from the first
  // row reaches the LAST view, never the act.
  it("an arrow key never starts a new chat: the open conversation survives (H18)", async () => {
    mount(stubClient({ threads: [{ id: "thr_1", title: "Where did July go?", updatedAt: iso(0) }] as ThreadSummary[] }));
    const row = await screen.findByRole("button", { name: "Where did July go?" });
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("page"));
    const apps = screen.getByRole("tab", { name: "Apps" });
    fireEvent.click(apps);
    apps.focus();
    // ArrowUp from the FIRST tab wraps to the last one. It used to land on
    // "New chat" and fire conversation.choose(undefined) — the open
    // conversation and the draft in its composer, gone, from a keystroke that
    // was only meant to move.
    fireEvent.keyDown(apps, { key: "ArrowUp" });
    expect(screen.getByRole("button", { name: "New chat" })).not.toBe(document.activeElement);
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Automations" }));
    // The conversation is untouched: it is still the open one.
    expect(row.getAttribute("aria-current")).toBe("page");
  });

  it("every tab's aria-controls resolves — there is ONE panel, not one per tab (M39)", async () => {
    mount(stubClient());
    const more = await screen.findByRole("button", { name: "More sections" });
    fireEvent.click(more);
    const tabs = screen.getAllByRole("tab");
    // ⚠️ TEST EDIT — four VIEWS (apps, automations, activity, accounts). The
    // fifth was "New chat", which is an act and no longer a tab.
    expect(tabs.length).toBe(4);
    const panel = screen.getByRole("tabpanel");
    for (const tab of tabs) {
      const controls = tab.getAttribute("aria-controls")!;
      expect(document.getElementById(controls), `${tab.textContent} controls a real element`).toBe(panel);
    }
  });

  it("a rail left open across midnight regroups (M40)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 7, 2, 23, 59));
      mount(stubClient({
        threads: [{ id: "thr_late", title: "Where did July go?", updatedAt: new Date(2026, 7, 2, 23, 30).toISOString() }] as ThreadSummary[],
      }));
      expect(await screen.findByText("Today")).toBeTruthy();
      // Two minutes later it is tomorrow, and last night's conversation is not
      // "Today" any more. The thread list has not changed — which is exactly
      // what the [threads] memo keyed on.
      vi.setSystemTime(new Date(2026, 7, 3, 0, 1));
      fireEvent.click(screen.getByRole("tab", { name: "Apps" }));
      await waitFor(() => expect(screen.getByText("Previous 7 days")).toBeTruthy());
      expect(screen.queryByText("Today")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closing ··· on an open Activity keeps a tab stop and a named panel (H10)", async () => {
    mount(stubClient());
    await screen.findByRole("tablist", { name: "Workspace sections" });
    const more = screen.getByRole("button", { name: "More sections" });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("heading", { name: "Activity" })).toBeTruthy();
    // Fold the row away again while Activity is what the column shows.
    fireEvent.click(more);
    expect(screen.queryByRole("tab", { name: "Activity" })).toBeNull();
    // The tablist still has exactly one keyboard entry point…
    const stops = screen.getAllByRole("tab").filter(tab => tab.getAttribute("tabindex") === "0");
    expect(stops.length).toBe(1);
    // …and the panel still has a NAME (its label can no longer be a tab that
    // does not exist).
    const panel = screen.getByRole("tabpanel", { name: "Activity" });
    expect(panel.getAttribute("aria-labelledby")).toBeNull();
  });

  // ⚠️ THE CLOCK IS PINNED, and it has to be. This read the REAL time and put
  // its "today" thread an hour before it, so between local midnight and 01:00
  // that thread belonged to YESTERDAY and the "Today" group did not exist. It
  // failed on CI at 00:26 UTC for exactly that reason, and reproduces on demand
  // with `TZ=UTC pnpm vitest run test/chrome/center.test.tsx -t "groups
  // conversations"` inside that window. A test that passes 23 hours a day is a
  // test that fails at random. Midday, so no offset crosses a boundary.
  it("groups conversations by recency and titles each row with its opening line", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 7, 3, 12, 0));
      mount(stubClient({
        threads: [
          { id: "thr_today", title: "Where did July go?", updatedAt: iso(3_600_000) },
          { id: "thr_week", title: "Build me a spending breakdown", updatedAt: iso(3 * DAY_MS) },
          { id: "thr_old", title: "An old question", updatedAt: iso(90 * DAY_MS) },
        ] as ThreadSummary[],
      }));
      expect(await screen.findByText("Today")).toBeTruthy();
      expect(screen.getByText("Previous 7 days")).toBeTruthy();
      expect(screen.getByText("Earlier")).toBeTruthy();
      const groups = screen.getAllByRole("group");
      const today = groups.find(group => group.textContent?.startsWith("Today"))!;
      expect(within(today).getByRole("button", { name: "Where did July go?" })).toBeTruthy();
      expect(within(today).queryByRole("button", { name: "An old question" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a run the user walked away from (M27)", () => {
  const surface = Symbol("test-thread-surface");
  const thread = (): ThreadSummary[] => [{ id: "thr_1", title: "Where did July go?", updatedAt: iso(0) }] as ThreadSummary[];
  afterEach(() => resetRunActivity());

  it("pulses the running conversation's row and narrates the finish", async () => {
    mount(stubClient({ threads: thread() }));
    const row = await screen.findByRole("button", { name: "Where did July go?" });
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("page"));
    // Walk away from the conversation — the run keeps going (§2 G1).
    fireEvent.click(screen.getByRole("tab", { name: "Apps" }));
    await screen.findByRole("heading", { name: "Apps" });

    act(() => publishThreadRun(surface, { threadId: "thr_1", status: "streaming", messages: [] }));
    // The row says a turn is live — from the run store, not from "is this the
    // row you happen to be viewing".
    await waitFor(() => expect(row.hasAttribute("data-vendo-running")).toBe(true));

    act(() => publishThreadRun(surface, {
      threadId: "thr_1",
      status: "ready",
      messages: [{ id: "m1", role: "assistant", parts: [{ type: "text", text: "July is ready" }] }] as never,
    }));
    // …and the finish is announced where the user actually is, with one way back.
    const toast = await screen.findByText("July is ready");
    expect(row.hasAttribute("data-vendo-running")).toBe(false);
    fireEvent.click(within(toast.closest(".fl-launcher-toast") as HTMLElement).getByRole("button", { name: "View" }));
    // ⚠️ TEST EDIT — a nav BUTTON says "you are here" with aria-current, which
    // is what the rail's own stylesheet has always keyed the selected look off.
    expect(screen.getByRole("button", { name: "New chat" }).getAttribute("aria-current")).toBe("page");
  });

  it("the pulse no longer requires the row to be the one you are viewing", async () => {
    const { CHROME_CSS } = await import("../../src/chrome/chrome-css.js");
    expect(CHROME_CSS).toContain(".fl-rail-chat[data-vendo-running] .fl-rail-pulse { display: block; }");
    expect(CHROME_CSS).not.toMatch(/aria-current="page"\] \.fl-rail-pulse/);
  });

  it("switching conversations remounts the column instead of re-labelling a live one", async () => {
    mount(stubClient({
      threads: [
        { id: "thr_1", title: "Where did July go?", updatedAt: iso(0) },
        { id: "thr_2", title: "An older question", updatedAt: iso(DAY_MS) },
      ] as ThreadSummary[],
    }));
    const composer = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "half-typed question" } });
    fireEvent.click(screen.getByRole("button", { name: "An older question" }));
    // A fresh conversation surface: without the key, the same instance kept the
    // previous thread's draft — and its in-flight turn.
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(""));
    expect(screen.getByRole("textbox", { name: "Message" })).not.toBe(composer);
  });
});

describe("Needs you", () => {
  it("exists only while asks are waiting, and carries the count", async () => {
    let waiting = [ask("apr_1"), ask("apr_2", "host_transfer_send")];
    mount(stubClient({ pending: () => waiting }));
    const section = await screen.findByRole("region", { name: /Needs you/ });
    expect(within(section).getByText("2")).toBeTruthy();
    // Settle them; the section retires on the next poll rather than lingering
    // as an empty header.
    waiting = [];
    await waitFor(
      () => expect(screen.queryByRole("region", { name: /Needs you/ })).toBeNull(),
      { timeout: 12000 },
    );
  });

  it("a new ask is announced, and so is the moment it settles (M31)", async () => {
    let waiting = [ask("apr_1")];
    mount(stubClient({ pending: () => waiting }));
    const rail = await screen.findByRole("navigation", { name: "Assistant" });
    const status = within(rail).getByRole("status");
    await waitFor(() => expect(status.textContent).toBe("1 thing needs you."));
    waiting = [];
    await waitFor(
      () => expect(status.textContent).toBe("Nothing is waiting on you now."),
      { timeout: 12000 },
    );
  });

  it("when the last ask settles under the user's feet, focus lands on the reason (H17)", async () => {
    let waiting = [ask("apr_1")];
    mount(stubClient({ pending: () => waiting }));
    const section = await screen.findByRole("region", { name: /Needs you/ });
    const row = within(section).getByRole("button", { name: /Email send/i });
    row.focus();
    expect(document.activeElement).toBe(row);
    // Decided somewhere else — the strip in the column, another tab, an
    // automation finishing. The rows go, and focus used to go to <body>.
    waiting = [];
    await waitFor(
      () => expect(document.activeElement?.textContent).toBe("Nothing is waiting on you now."),
      { timeout: 12000 },
    );
  });

  it("is absent from the first paint when nothing is waiting", async () => {
    mount(stubClient());
    await screen.findByRole("tab", { name: "Apps" });
    expect(screen.queryByRole("region", { name: /Needs you/ })).toBeNull();
    expect(screen.queryByText("Needs you")).toBeNull();
  });
});

describe("the home shelf", () => {
  it("day zero: ghost tiles advertise what to build (§14 CS2)", async () => {
    mount(stubClient());
    const shelf = await screen.findByRole("region", { name: "What you could build" });
    const ghosts = within(shelf).getAllByRole("button");
    expect(ghosts.length).toBeGreaterThan(0);
    expect(shelf.textContent).toMatch(/tap to build/i);
    expect(screen.queryByRole("region", { name: "Your apps" })).toBeNull();
  });

  it("a live tile's preview is inert, not aria-hidden-with-focusables (H11)", async () => {
    mount(stubClient({ apps: [appDoc("app_1", "Invoices")] }));
    const shelf = await screen.findByRole("region", { name: "Your apps" });
    await within(shelf).findByText("Invoices app surface");
    const preview = shelf.querySelector(".fl-tile-view")!;
    // The generated view really does carry its own focusable furniture…
    expect(preview.querySelector("button")).toBeTruthy();
    // …so hiding it from assistive tech while leaving it in the tab order is the
    // defect. `inert` does both halves; aria-hidden does neither safely.
    expect(preview.hasAttribute("inert")).toBe(true);
    expect(preview.getAttribute("aria-hidden")).toBeNull();
    // Every focusable inside the tile sits under that inert wrapper — the only
    // thing the keyboard can reach on a tile is its own "Open" hit area.
    const reachable = [...shelf.querySelectorAll<HTMLElement>("button,input,select,textarea,a[href],[tabindex]")]
      .filter(node => node.closest("[inert]") === null);
    expect(reachable.map(node => node.getAttribute("aria-label"))).toEqual(["Open Invoices"]);
  });

  it("once an app exists the ghosts are gone and the shelf is live", async () => {
    mount(stubClient({ apps: [appDoc("app_1", "Invoices")] }));
    const shelf = await screen.findByRole("region", { name: "Your apps" });
    expect(within(shelf).getByRole("button", { name: "Open Invoices" })).toBeTruthy();
    // A LIVE tile: the app's own rendered view, not its name on a card.
    expect(await within(shelf).findByText("Invoices app surface")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "What you could build" })).toBeNull();
  });
});

describe("mobile P1 (§12)", () => {
  const TAKEOVER_QUERY = "(max-width: 767px)";
  /** jsdom has no matchMedia; only the takeover query matches (the same stub
   *  shape mobile-takeover.test.tsx installs). */
  // Restored after each case: a leaked stub would render every later case
  // (and every later FILE, under the same worker) as the mobile takeover.
  const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
  afterEach(() => {
    if (original) Object.defineProperty(window, "matchMedia", original);
    else delete (window as { matchMedia?: unknown }).matchMedia;
  });
  const installMobile = () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query === TAKEOVER_QUERY,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
      }),
    });
  };

  it("is one page under the host's route: a compact header and a slide-in history sheet", async () => {
    installMobile();
    mount(stubClient({ threads: [{ id: "thr_1", title: "Where did July go?", updatedAt: iso(0) }] as ThreadSummary[] }));
    // The header, not a second app bar: no tablist, no brand row, no user row.
    expect(await screen.findByText("Assistant")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Assistant sections" });
    for (const name of ["Chats", "Apps", "Automations", "New"]) {
      expect(within(nav).getByRole("button", { name })).toBeTruthy();
    }
    // History is a sheet, opened from the header and dismissable.
    const chats = within(nav).getByRole("button", { name: "Chats" });
    expect(chats.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("complementary", { name: "Conversations" })).toBeNull();
    fireEvent.click(chats);
    const sheet = await screen.findByRole("complementary", { name: "Conversations" });
    expect(within(sheet).getByRole("button", { name: "Where did July go?" })).toBeTruthy();
    // The panels the desktop rail folds under ··· live in the sheet on mobile.
    expect(within(sheet).getByRole("button", { name: "Activity" })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Close conversations" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Conversations" })).toBeNull());
  });

  it("choosing a conversation from the sheet lands focus in the column (H17)", async () => {
    installMobile();
    mount(stubClient({ threads: [{ id: "thr_1", title: "Where did July go?", updatedAt: iso(0) }] as ThreadSummary[] }));
    const nav = await screen.findByRole("navigation", { name: "Assistant sections" });
    fireEvent.click(within(nav).getByRole("button", { name: "Chats" }));
    const sheet = await screen.findByRole("complementary", { name: "Conversations" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Where did July go?" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Conversations" })).toBeNull());
    // The sheet the keyboard was standing in is gone; the column it chose has it.
    expect(document.activeElement?.className).toContain("fl-center-main");
  });

  it("the history sheet has a keyboard contract: focus in, trapped, Escape out, focus back (M34)", async () => {
    installMobile();
    mount(stubClient({ threads: [{ id: "thr_1", title: "Where did July go?", updatedAt: iso(0) }] as ThreadSummary[] }));
    const nav = await screen.findByRole("navigation", { name: "Assistant sections" });
    const chats = within(nav).getByRole("button", { name: "Chats" });
    chats.focus();
    fireEvent.click(chats);
    const sheet = await screen.findByRole("complementary", { name: "Conversations" });

    // Focus went INTO the sheet (its first stop is the close button).
    const close = within(sheet).getByRole("button", { name: "Close conversations" });
    expect(document.activeElement).toBe(close);

    // Tab cycles inside it rather than walking out into the covered page.
    const stops = [...sheet.querySelectorAll<HTMLElement>("button")];
    const last = stops.at(-1)!;
    last.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    // Escape dismisses, and focus goes back to the button that opened it.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Conversations" })).toBeNull());
    expect(document.activeElement).toBe(chats);
  });
});

/** MEDIUM (post-check) — a tile preview had ONE visual state for three
 *  situations: never scrolled to, booting, and booted-and-FAILED. A failed boot
 *  sat under a pulsing skeleton forever, promising a view that was never
 *  coming. */
describe("a tile preview says which of its states it is in", () => {
  it("shows an honest line when the app's boot failed, and no developer text", async () => {
    mount(stubClient({ apps: [appDoc("app_1", "Invoices")], openFails: true }));
    const failed = await waitFor(
      () => {
        const node = document.querySelector('[data-vendo-preview="failed"]');
        expect(node).toBeTruthy();
        return node!;
      },
      { timeout: 12_000 },
    );
    expect(failed.textContent).toBe("This didn’t load.");
    expect(failed.textContent).not.toContain("VENDO_API_KEY");
    expect(document.querySelector(".fl-tile-skel")).toBeNull();
    // The tile still offers the one thing that can help: opening the app,
    // where OpenApp carries the Try again (ruling 18).
    expect(screen.getByRole("button", { name: "Open Invoices" })).toBeTruthy();
  }, 20_000);

});

/** H-4 — the tile's preview must be inert on BOTH supported React majors. The
 *  suite runs on React 19, which knows the JSX `inert` prop; React 18 (in the
 *  peer range) drops it with a warning, so the attribute has to be set on the
 *  node rather than declared as a prop. Both halves are asserted: the attribute
 *  really lands, and the component does not go back to the prop that only one
 *  major honours. */
describe("the tile preview is inert on every supported React (H-4)", () => {
  it("carries the real attribute on the rendered node", async () => {
    mount(stubClient({ apps: [appDoc("app_1", "Invoices")] }));
    const view = await waitFor(() => {
      const node = document.querySelector(".fl-tile-view");
      expect(node).toBeTruthy();
      return node!;
    });
    expect(view.hasAttribute("inert")).toBe(true);
  });

  it("does not rely on the JSX prop React 18 throws away", () => {
    const source = readFileSync("src/chrome/center/home.tsx", "utf8");
    // `<div className="fl-tile-view" inert>` — the shape that renders nothing at
    // all on a React 18 host.
    expect(source).not.toMatch(/\binert\b(?!\w)\s*(?:=\s*\{?(?:true|""|''|\{\})\}?)?\s*>/);
  });
});

// H16 (round C's mechanism, adopted here): TilePreview is the ONE place both the
// home shelf and the Apps grid boot an app, so the gate belongs there — the grid
// maps the FULL list, and every tile is a real `apps.get` + `apps.open` (often an
// iframe too). jsdom has no IntersectionObserver, so this case installs one.
describe("the app boot gate on the Apps grid (H16)", () => {
  type Watcher = { node: Element; fire(entries: { isIntersecting: boolean }[]): void };
  class Observer {
    static watchers: Watcher[] = [];
    #callback: (entries: { isIntersecting: boolean }[]) => void;
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      this.#callback = callback;
    }
    observe(node: Element) { Observer.watchers.push({ node, fire: this.#callback }); }
    disconnect() {}
  }
  /** Scroll one tile into view: every watcher standing on that node answers. */
  const scrollTo = (node: Element) => act(() => {
    for (const watcher of Observer.watchers.filter(entry => entry.node === node)) {
      watcher.fire([{ isIntersecting: true }]);
    }
  });
  /** Previews being watched RIGHT NOW (the home shelf's own tiles were watched
   *  and then unmounted when the Apps door opened). */
  const watched = () => new Set(Observer.watchers.map(entry => entry.node).filter(node => node.isConnected));
  beforeEach(() => {
    Observer.watchers = [];
    Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, writable: true, value: Observer });
  });
  afterEach(() => Reflect.deleteProperty(globalThis, "IntersectionObserver"));

  it("boots nothing for a tile nobody has scrolled to, then exactly one when they do", async () => {
    const log: string[] = [];
    mount(stubClient({
      log,
      apps: [appDoc("app_1", "Invoices"), appDoc("app_2", "Payroll"), appDoc("app_3", "Receipts")],
    }));
    // Land on the Apps door FIRST (the home shelf caps itself at four tiles for
    // the same reason; the grid is the unbounded one).
    fireEvent.click(await screen.findByRole("tab", { name: "Apps" }));
    await screen.findByRole("heading", { name: "Apps", exact: true });
    // Three tiles, three watched previews, and not one app booted.
    await waitFor(() => expect(watched().size).toBe(3));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(log).toEqual([]);
    expect(document.querySelectorAll(".fl-tile-skel").length).toBe(3);

    // The reader scrolls the first tile into view.
    scrollTo(document.querySelectorAll(".fl-tile")[0]!.querySelector(".fl-tile-skel")!);
    await waitFor(() => expect(log).toEqual(["get:app_1", "open:app_1"]));
    expect(await screen.findByText("Invoices app surface")).toBeTruthy();
    // The two below the fold still cost nothing.
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(log).toEqual(["get:app_1", "open:app_1"]);
  });

  it("says WHICH nothing a tile is showing: never-scrolled-to is not booting", async () => {
    // The MEDIUM finding's other half: a tile that never intersects rendered
    // the same pulsing skeleton as one whose boot is in flight, so the surface
    // claimed to be loading something it had not asked for.
    mount(stubClient({ apps: [appDoc("app_1", "Invoices"), appDoc("app_2", "Payroll")] }));
    fireEvent.click(await screen.findByRole("tab", { name: "Apps" }));
    await screen.findByRole("heading", { name: "Apps", exact: true });
    await waitFor(() => expect(watched().size).toBe(2));
    const state = () => [...document.querySelectorAll("[data-vendo-preview]")]
      .map(node => node.getAttribute("data-vendo-preview"));
    expect(state()).toEqual(["idle", "idle"]);

    scrollTo(document.querySelectorAll(".fl-tile")[0]!.querySelector(".fl-tile-skel")!);
    await waitFor(() => expect(state()[1]).toBe("idle"));
    expect(await screen.findByText("Invoices app surface")).toBeTruthy();
  });
});

describe("the named doors", () => {
  it("Apps opens the tile grid with the honest empty line, and the caption points at the composer", async () => {
    mount(stubClient());
    fireEvent.click(await screen.findByRole("tab", { name: "Apps" }));
    expect(await screen.findByRole("heading", { name: "Apps" })).toBeTruthy();
    expect(screen.getByText(/nothing yet/i)).toBeTruthy();
    expect(screen.getByText(/ask below to build a new one/i)).toBeTruthy();
  });

  it("Apps: a tile opens the app full in the column", async () => {
    mount(stubClient({ apps: [appDoc("app_1", "Invoices")] }));
    fireEvent.click(await screen.findByRole("tab", { name: "Apps" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Invoices" }));
    const open = await screen.findByRole("region", { name: "Invoices" });
    expect(within(open).getByText("Invoices app surface")).toBeTruthy();
  });

  it("focus follows the navigation: into the opened app, back to its tile (H17)", async () => {
    mount(stubClient({ apps: [appDoc("app_1", "Invoices")] }));
    fireEvent.click(await screen.findByRole("tab", { name: "Apps" }));
    const tile = await screen.findByRole("button", { name: "Open Invoices" });
    fireEvent.click(tile);
    const open = await screen.findByRole("region", { name: "Invoices" });
    // The grid the keyboard was standing in is gone; focus went with the user.
    expect(document.activeElement).toBe(open);
    fireEvent.click(within(open).getByRole("button", { name: "← All apps" }));
    // Coming back is a return: focus lands on the tile it came from.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open Invoices" })));
  });

  it("H-3 — opening from the HOME SHELF still lands focus on the way back", async () => {
    // `cameFrom` is written only by the Apps grid's own tile, so the two other
    // ways into an open app (the home shelf, and this page's create field) hit
    // the early return and dropped focus on <body>. The heading is the promised
    // fallback: the grid the user is returning to was never on screen.
    mount(stubClient({ apps: [appDoc("app_1", "Invoices")] }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Invoices" }));
    const open = await screen.findByRole("region", { name: "Invoices" });
    fireEvent.click(within(open).getByRole("button", { name: "← All apps" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Apps" })));
  });

  it("an opened app names its region from the FIRST paint, not after the fetch (M40)", async () => {
    mount(stubClient({ apps: [appDoc("app_1", "Invoices")] }));
    fireEvent.click(await screen.findByRole("tab", { name: "Apps" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Invoices" }));
    // No await: the region must already be "Invoices" while the surface loads.
    expect(screen.getByRole("region", { name: "Invoices" })).toBeTruthy();
  });

  it("Automations opens the existing panel, unchanged", async () => {
    mount(stubClient());
    fireEvent.click(await screen.findByRole("tab", { name: "Automations" }));
    expect(await screen.findByRole("heading", { name: "Automations" })).toBeTruthy();
    expect(screen.getByText(/no automations yet/i)).toBeTruthy();
  });
});

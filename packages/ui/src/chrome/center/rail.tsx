/** The center's in-page rail (redesign spec §10 X1, §12 page-inside-host-app).
 *
 *  It is a RAIL, not an app frame: no brand row, no user row, no search — the
 *  host's own application chrome surrounds the center everywhere it mounts, and
 *  §12's standing law is that we never bring a shell of our own. What lives here
 *  is only what the center itself owns: the two named doors, the attention
 *  section while it has something to say, and the conversations.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useVendoProvider } from "../../context.js";
import { useAttention } from "../../hooks/use-approvals.js";
import type { ThreadSummary } from "../../wire-types.js";
import { toolTitle } from "../humanize.js";
import { ACTIVITY_ANCHOR_ATTRIBUTE } from "../morph-toast.js";

/** The center's views. `chat` is the conversation column (and the home). */
export type CenterView = "chat" | "apps" | "automations" | "activity" | "accounts";

/** The two named doors under New chat (§10: "the home stays pure … the sidebar
 *  gets two nav rows under New chat").
 *
 *  `chat` is NOT here. It is an ACT, not a view you switch to, and it renders as
 *  its own button ABOVE the tablist — see {@link RailNav}. */
const PRIMARY: CenterView[] = ["apps", "automations"];
/** Everything that used to be a top-level tab and is not a door: reachable
 *  under the quiet ··· row, opening the same panels unchanged. */
const SECONDARY: CenterView[] = ["activity", "accounts"];

/** The ONE panel every tab controls: the column swaps its contents, it is never
 *  a panel per tab. (Each tab used to point `aria-controls` at `vendo-panel-<its
 *  own view>`, so four of the five references pointed at nothing.) */
export const CENTER_PANEL_ID = "vendo-center-panel";

/** The rows the tablist actually renders. Exported because the column's panel
 *  has to know whether the view it is showing still HAS a tab: closing the ···
 *  row while Activity is open removes the tab that labelled it. */
export function railRows(moreOpen: boolean): CenterView[] {
  return moreOpen ? [...PRIMARY, ...SECONDARY] : PRIMARY;
}

const LABEL: Record<CenterView, string> = {
  chat: "New chat",
  apps: "Apps",
  automations: "Automations",
  activity: "Activity",
  accounts: "Accounts",
};

/** The view's own words, for a surface that has to name it without a tab. */
export function centerViewLabel(view: CenterView): string {
  return LABEL[view];
}

/** Same cadence as the waiting strip: an ask raised elsewhere (an automation
 *  run, another tab) reaches the badge without a reload. */
const NEEDS_POLL_MS = 5_000;

/** The history sheet's tab cycle (same shape as the overlay panel's). */
const SHEET_FOCUSABLE = "button:not([disabled]),input:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])";

function Glyph({ view }: { view: CenterView }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (view === "chat") return <svg {...common}><path d="M12 5v14" /><path d="M5 12h14" /></svg>;
  if (view === "apps") {
    return (
      <svg {...common}>
        <rect width="7" height="7" x="3" y="3" rx="1.5" /><rect width="7" height="7" x="14" y="3" rx="1.5" />
        <rect width="7" height="7" x="3" y="14" rx="1.5" /><rect width="7" height="7" x="14" y="14" rx="1.5" />
      </svg>
    );
  }
  if (view === "automations") return <svg {...common}><path d="m13 2-9 12h8l-1 8 9-12h-8l1-8Z" /></svg>;
  if (view === "activity") return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>;
  return <svg {...common}><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></svg>;
}

export interface RailNavProps {
  view: CenterView;
  onView(view: CenterView): void;
  /** Whether the ··· row is expanded (Activity + Accounts revealed). */
  moreOpen: boolean;
  onMoreOpen(open: boolean): void;
  /** Lane pick 4-C — the approved pill docks into the Activity row; the pulse
   *  answers, teaching where receipts live. Rides the ··· row while Activity
   *  itself is folded away, so the dock always has somewhere to land. */
  activityBump: boolean;
}

/** The section switcher: New chat, then real WAI-ARIA tabs in ONE vertical
 *  tablist — the ··· disclosure sits outside it, and the rows it reveals join
 *  the same list rather than forming a second one.
 *
 *  NEW CHAT IS NOT A TAB. It is an ACT: it discards the open conversation and
 *  the composer's draft (`goto` in vendo-page calls `conversation.choose(
 *  undefined)`). Giving it `role="tab"` made it inaccessible as what it is —
 *  a `getByRole("button", { name: "New conversation" })`, which is how the
 *  overlay, the palette and the mobile header all expose the same gesture,
 *  matched nothing on the page surface — and it forced the whole tablist onto
 *  MANUAL activation, because an arrow key that activated as it moved would
 *  have destroyed the user's work on the way past.
 *
 *  With the act lifted out, every remaining row is a view whose panel appears
 *  instantly, so the tablist takes APG's AUTOMATIC activation: arrows move the
 *  selection. Enter/Space still work, because they are buttons. */
export function RailNav({ view, onView, moreOpen, onMoreOpen, activityBump }: RailNavProps) {
  const rows = railRows(moreOpen);
  // Roving tabindex. Selection follows focus now, so the stop IS the selected
  // row — no separate "last focused" state to keep in step with it. The
  // selection can be a row that is not here (chat, or Activity with the ···
  // row closed again), and a tablist where every row is tabIndex -1 cannot be
  // reached by keyboard at all, so it falls back to the first row.
  const stop = Math.max(0, rows.indexOf(view));
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % rows.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index - 1 + rows.length) % rows.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else return;
    event.preventDefault();
    // Automatic activation: the arrow moves the selection, not just the focus.
    onView(rows[next]!);
    refs.current[next]?.focus();
  };
  // The ··· row carries the dock while Activity is folded away.
  const anchored: CenterView | "more" = moreOpen ? "activity" : "more";
  return (
    <>
      {/* The act, outside the tablist. `aria-current` (not `aria-selected`) is
          what a nav row uses to say "you are here", and the rail's stylesheet
          already keys the selected look off both. */}
      <button
        type="button"
        className="fl-rail-row fl-rail-new"
        aria-current={view === "chat" ? "page" : undefined}
        onClick={() => onView("chat")}
      >
        <Glyph view="chat" />
        {LABEL.chat}
      </button>
      <div className="fl-rail-nav" role="tablist" aria-orientation="vertical" aria-label="Workspace sections">
        {rows.map((row, index) => (
          <button
            ref={node => { refs.current[index] = node; }}
            className={`fl-rail-row${row === "activity" && activityBump ? " fl-tab--bump" : ""}`}
            id={`vendo-tab-${row}`}
            type="button"
            role="tab"
            aria-selected={view === row}
            aria-controls={CENTER_PANEL_ID}
            tabIndex={index === stop ? 0 : -1}
            key={row}
            onClick={() => onView(row)}
            onKeyDown={event => move(event, index)}
            {...(anchored === row ? { [ACTIVITY_ANCHOR_ATTRIBUTE]: "" } : {})}
          >
            <Glyph view={row} />
            {LABEL[row]}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`fl-rail-more${anchored === "more" && activityBump ? " fl-tab--bump" : ""}`}
        aria-label="More sections"
        aria-expanded={moreOpen}
        onClick={() => onMoreOpen(!moreOpen)}
        {...(anchored === "more" ? { [ACTIVITY_ANCHOR_ATTRIBUTE]: "" } : {})}
      >
        <span aria-hidden="true">···</span>
      </button>
    </>
  );
}

/** §4 attention — the pinned section that EXISTS only while asks are waiting,
 *  numbered. Counts from Lane D's ONE attention source (`useAttention`), the
 *  same hook the waiting strip and the launcher badge read, so the rail can
 *  never show a different number than the surface you land on. Read-only:
 *  deciding stays with the surfaces built for it (the strip above the
 *  conversation, the card in the transcript), so a rail row's one job is
 *  taking you there. */
export function NeedsYou({ onOpen }: { onOpen(): void }) {
  const { tools } = useVendoProvider();
  const { askCount, asks } = useAttention({ pollMs: NEEDS_POLL_MS });
  const spoken = useAskAnnouncement(askCount);
  const settled = useRef<HTMLParagraphElement>(null);
  // Whether the rows that are about to disappear are holding the keyboard: an
  // ask decided ANYWHERE (the strip in the column, another tab, an automation
  // finishing) retires this whole section, and focus was landing on <body>.
  const held = useRef(false);
  useEffect(() => {
    if (askCount > 0 || !held.current) return;
    held.current = false;
    // The line that says why the rows went is the honest place to stand.
    settled.current?.focus();
  }, [askCount]);
  return (
    <>
      {/* The spoken half. An ask can arrive from anywhere — an automation run,
          another tab — and the section appearing silently told nobody; the
          section VANISHING told nobody either. A live region has to be mounted
          BEFORE its words change to be announced reliably, so it lives out here
          (empty until something happens) rather than inside the section that
          comes and goes. */}
      <p className="fl-sr-only" role="status" tabIndex={-1} ref={settled}>{spoken}</p>
      {askCount === 0 ? null : (
        <section
          className="fl-rail-group"
          aria-label={`Needs you — ${askCount} waiting`}
          onFocus={() => { held.current = true; }}
          onBlur={() => { held.current = false; }}
        >
          <p className="fl-rail-label">
            Needs you
            <span className="fl-rail-badge">{askCount}</span>
          </p>
          {asks.map(approval => (
            <button type="button" className="fl-rail-chat fl-rail-need" key={approval.id} onClick={onOpen}>
              {toolTitle(approval.call.tool, tools[approval.call.tool])}
            </button>
          ))}
        </section>
      )}
    </>
  );
}

/** What the live region says, in the user's words: only ever the CHANGE. */
function useAskAnnouncement(askCount: number): string {
  const [spoken, setSpoken] = useState("");
  const previous = useRef(askCount);
  useEffect(() => {
    const was = previous.current;
    previous.current = askCount;
    if (askCount === was) return;
    if (askCount === 0) {
      setSpoken("Nothing is waiting on you now.");
      return;
    }
    setSpoken(askCount === 1 ? "1 thing needs you." : `${askCount} things need you.`);
  }, [askCount]);
  return spoken;
}

interface ThreadGroup {
  label: string;
  id: string;
  threads: ThreadSummary[];
}

/** Recency groups (§10 "conversations grouped by recency"). "Earlier" is not
 *  decoration: a thread from March has to land somewhere true, and calling it
 *  "Previous 7 days" would be a lie. Empty groups never render. */
function groupThreads(threads: ThreadSummary[], now: number): ThreadGroup[] {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const weekAgo = startOfToday - 6 * 86_400_000;
  const groups: ThreadGroup[] = [
    { label: "Today", id: "today", threads: [] },
    { label: "Previous 7 days", id: "week", threads: [] },
    { label: "Earlier", id: "earlier", threads: [] },
  ];
  for (const thread of threads) {
    const at = Date.parse(thread.updatedAt);
    // An unparseable timestamp is not evidence of age — group it with the
    // newest rather than exiling it to "Earlier".
    const bucket = Number.isNaN(at) || at >= startOfToday ? 0 : at >= weekAgo ? 1 : 2;
    groups[bucket]!.threads.push(thread);
  }
  return groups.filter(group => group.threads.length > 0);
}

export interface CenterChatsProps {
  threads: ThreadSummary[];
  activeId: string | undefined;
  /** The conversation a turn is running in, if any (§10 "a running background
   *  turn shows a quiet pulse on its row"). Read from the run-activity store by
   *  the page — the row it marks does NOT have to be the one you are viewing. */
  runningId?: string | undefined;
  onSelect(id: string): void;
}

/** The conversation rows. A row's title is the conversation's opening line (the
 *  wire's own thread title), ellipsized by CSS — never truncated in JS, so the
 *  full line stays available to assistive tech and to a wider rail. */
export function CenterChats({ threads, activeId, runningId, onSelect }: CenterChatsProps) {
  // Not memoized on [threads]: "today" is a fact about the CLOCK, and a rail
  // left open across midnight kept yesterday's answer (the grouping is three
  // comparisons over a short list — there was nothing to save).
  const groups = groupThreads(threads, Date.now());
  return (
    <>
      {groups.map(group => (
        <div className="fl-rail-group" role="group" aria-labelledby={`vendo-rail-${group.id}`} key={group.id}>
          <p className="fl-rail-label" id={`vendo-rail-${group.id}`}>{group.label}</p>
          {group.threads.map(thread => (
            <button
              type="button"
              className="fl-rail-chat"
              aria-current={activeId === thread.id ? "page" : undefined}
              {...(runningId === thread.id ? { "data-vendo-running": "" } : {})}
              key={thread.id}
              onClick={() => onSelect(thread.id)}
            >
              {thread.title}
              {/* The running-turn pulse (§10 "a running background turn shows a
                  quiet pulse on its row"), painted from the run store rather
                  than from "is this the row you are looking at" — the CSS used
                  to require aria-current, so the one row it could never mark was
                  a background one. */}
              <span className="fl-rail-pulse" aria-hidden="true" />
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

export interface CenterHeaderProps {
  view: CenterView;
  onView(view: CenterView): void;
  /** Opens the conversation-history sheet. */
  onChats(): void;
  chatsOpen: boolean;
}

/** Mobile P1 (§12) — ONE self-contained page under the host's own tab or menu
 *  item: a compact in-page header, never a second app bar. Plain navigation
 *  semantics rather than the desktop tablist: there is no roving-focus keyboard
 *  to serve here, and `aria-current` says exactly what the highlight means. */
export function CenterHeader({ view, onView, onChats, chatsOpen }: CenterHeaderProps) {
  return (
    <header className="fl-center-head">
      <span className="fl-center-head-title">Assistant</span>
      <nav className="fl-center-head-nav" aria-label="Assistant sections">
        <button
          type="button"
          className="fl-center-head-btn"
          aria-expanded={chatsOpen}
          aria-controls="vendo-center-sheet"
          onClick={onChats}
        >Chats</button>
        {(["apps", "automations"] as const).map(row => (
          <button
            type="button"
            className="fl-center-head-btn"
            key={row}
            aria-current={view === row ? "page" : undefined}
            onClick={() => onView(row)}
          >{LABEL[row]}</button>
        ))}
        <button type="button" className="fl-center-head-btn fl-center-head-new" onClick={() => onView("chat")}>New</button>
      </nav>
    </header>
  );
}

/** The slide-in history sheet: conversations, the attention section, and the
 *  panels the desktop rail folds under ···. Mounted only while open (so the
 *  entrance plays and nothing off-screen holds focus), with a scrim that
 *  dismisses — the page underneath stays a page.
 *
 *  It covers the page and holds the keyboard while it is up, so it keeps the
 *  same contract every other Vendo surface keeps (the overlay panel, the
 *  approval sheet): focus lands inside on open, Tab cycles inside it, Escape
 *  dismisses, and dismissing hands focus back to the button that opened it.
 *  Choosing a row is NOT a dismissal — the caller moves focus into the column
 *  it just navigated to. */
export function CenterSheet({ view, onView, onClose, children }: {
  view: CenterView;
  onView(view: CenterView): void;
  onClose(): void;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismiss = () => {
    opener.current?.focus();
    closeRef.current();
  };
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (sheet.querySelector<HTMLElement>(SHEET_FOCUSABLE) ?? sheet).focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        opener.current?.focus();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const stops = [...sheet.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE)];
      const edge = event.shiftKey ? stops[0] : stops.at(-1);
      if (stops.length === 0 || document.activeElement !== edge) return;
      event.preventDefault();
      (event.shiftKey ? stops.at(-1) : stops[0])?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <>
      <div className="fl-center-scrim" onClick={dismiss} />
      <aside
        ref={sheetRef}
        className="fl-center-sheet"
        id="vendo-center-sheet"
        aria-label="Conversations"
        tabIndex={-1}
      >
        <div className="fl-center-sheet-top">
          <button type="button" className="fl-center-head-btn" onClick={dismiss} aria-label="Close conversations">✕</button>
        </div>
        {children}
        <nav className="fl-rail-nav" aria-label="More sections">
          {SECONDARY.map(row => (
            <button
              type="button"
              className="fl-rail-row"
              key={row}
              aria-current={view === row ? "page" : undefined}
              onClick={() => onView(row)}
            >
              <Glyph view={row} />
              {LABEL[row]}
            </button>
          ))}
        </nav>
      </aside>
    </>
  );
}

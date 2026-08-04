import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useVendoContext } from "../context.js";
import type { ThreadSummary } from "../wire-types.js";
import { useApp } from "../hooks/use-app.js";
import { useApps } from "../hooks/use-apps.js";
import { useMobileTakeover } from "../hooks/use-mobile-takeover.js";
import { useThreads } from "../hooks/use-threads.js";
import { AppFrame } from "../tree/frames.js";
import { ActivityPanel } from "./activity-panel.js";
import { AutomationsPanel } from "./automations-panel.js";
import { ChromeRoot } from "./chrome-root.js";
import { ACTIVITY_ANCHOR_ATTRIBUTE, ACTIVITY_BUMP_EVENT } from "./morph-toast.js";
import { ConnectedAccountsPanel } from "./connected-accounts-panel.js";
import { TakeoverPortal } from "./takeover-portal.js";
import { VendoThread, type VendoThreadProps } from "./thread/index.js";
import { WaitingQueue } from "./waiting-queue.js";

/** Host passthrough for the chat tab's thread — the same starter cards, hero
    copy (title · tagline · eyebrow · icon) and discoverability dial a
    standalone VendoThread takes, so a host's curated landing survives the move
    onto the full workspace. */
export interface VendoPageProps {
  thread?: Pick<
    VendoThreadProps,
    "suggestions" | "discoverability" | "greeting" | "intro" | "heroEyebrow" | "heroIcon"
  >;
}

const TABS = ["chat", "apps", "automations", "accounts", "activity"] as const;

// How long a minted-thread sidebar retry waits before re-polling GET /threads
// (the mint header lands at turn START; the thread row persists at turn END).
const MINTED_RETRY_MS = 1_000;
type Tab = typeof TABS[number];

function title(tab: Tab): string {
  return tab[0]!.toUpperCase() + tab.slice(1);
}

const DAY_MS = 86_400_000;

/** Sift-style date grouping: split the (recency-ordered) list into "Last 30
 *  days" and "Older than last month". Headers only appear when BOTH buckets
 *  have entries — otherwise a single clean, unlabelled list (the grouping is a
 *  nicety, never a requirement). */
function groupThreads(threads: ThreadSummary[], now: number): { label?: string; items: ThreadSummary[] }[] {
  const recent: ThreadSummary[] = [];
  const older: ThreadSummary[] = [];
  for (const thread of threads) {
    const ts = Date.parse(thread.updatedAt);
    if (!Number.isNaN(ts) && now - ts > 30 * DAY_MS) older.push(thread);
    else recent.push(thread);
  }
  if (recent.length > 0 && older.length > 0) {
    return [
      { label: "Last 30 days", items: recent },
      { label: "Older than last month", items: older },
    ];
  }
  return [{ items: threads }];
}

/** The conversation rail (Sift-style): a quiet "+" in the header for a new
 *  conversation, then text-forward rows — truncated title, subtle hover, light
 *  selected wash, and a "…" overflow menu (Delete) that fades in on hover. */
function ConversationList({ threads, activeId, onSelect, onNew, onDelete, divided }: {
  threads: ThreadSummary[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  // In the two-column desktop layout the rail carries a vertical divider on its
  // right edge (same 1px --vendo-border hairline the host nav uses); the mobile
  // takeover stacks the rail above the thread, where a divider would misread.
  divided?: boolean;
}) {
  const [menuFor, setMenuFor] = useState<string | undefined>();
  // Any click outside the open menu (or Escape) dismisses it. The trigger and
  // the menu itself stop propagation, so this only ever fires for outside hits.
  useEffect(() => {
    if (menuFor === undefined) return;
    const close = () => setMenuFor(undefined);
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setMenuFor(undefined); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);
  // Date.now() only re-reads when the list changes — buckets don't drift within
  // a session, and this component is client-only (no SSR hydration concern).
  const groups = useMemo(() => groupThreads(threads, Date.now()), [threads]);
  return (
    <nav className={`fl-convos${divided ? " fl-convos--divided" : ""}`} aria-label="Conversations">
      <div className="fl-convos-head">
        <span className="fl-convos-label">Conversations</span>
        <button type="button" className="fl-convos-new" aria-label="New conversation" onClick={onNew}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14" /><path d="M5 12h14" />
          </svg>
        </button>
      </div>
      <div className="fl-convos-list">
        {threads.length === 0 ? <p className="fl-convos-empty">No conversations yet.</p> : null}
        {groups.map((group, groupIndex) => (
          <Fragment key={group.label ?? groupIndex}>
            {group.label ? <div className="fl-convos-group">{group.label}</div> : null}
            {group.items.map(thread => {
              const open = menuFor === thread.id;
              return (
                <div
                  className={`fl-convo-row${activeId === thread.id ? " is-active" : ""}${open ? " is-menu-open" : ""}`}
                  key={thread.id}
                >
                  <button
                    type="button"
                    className="fl-convo-open"
                    aria-current={activeId === thread.id ? "page" : undefined}
                    title={thread.title}
                    onClick={() => onSelect(thread.id)}
                  ><span className="fl-convo-title">{thread.title}</span></button>
                  <button
                    type="button"
                    className="fl-convo-more"
                    aria-label="Conversation options"
                    aria-haspopup="menu"
                    aria-expanded={open}
                    onClick={event => { event.stopPropagation(); setMenuFor(open ? undefined : thread.id); }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
                    </svg>
                  </button>
                  {open ? (
                    <div className="fl-convo-menu" role="menu" onClick={event => event.stopPropagation()}>
                      <button
                        type="button"
                        role="menuitem"
                        className="fl-convo-del"
                        onClick={() => { setMenuFor(undefined); onDelete(thread.id); }}
                      >Delete conversation</button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </nav>
  );
}

function ChatWorkspace({ thread }: { thread?: VendoPageProps["thread"] }) {
  const takeover = useMobileTakeover();
  const { threads, isLoading, error: threadsError, refresh, remove } = useThreads();
  const [selected, setSelected] = useState<string>();
  // ENG-222 — the thr_ the server mints for a "New conversation" turn. Tracked
  // separately from `selected` (which drives VendoThread's threadId prop) so a
  // fresh mint highlights the sidebar without remounting the live conversation.
  const [minted, setMinted] = useState<string>();
  const activeId = selected ?? minted;
  // Default to the most recent conversation until the user makes an explicit
  // choice. `userChose` is set synchronously in the button handlers so that an
  // explicit "New conversation" (selected → undefined) can never be clobbered by
  // this effect — which, being passive, may flush AFTER the click and would
  // otherwise resurrect the previous thread via `?? threads[0]` (ENG-222).
  const userChose = useRef(false);
  useEffect(() => {
    if (userChose.current || threads.length === 0) return;
    setSelected(current => current ?? threads[0]?.id);
  }, [threads]);
  const onThreadId = useCallback((id: string) => setMinted(id), []);
  const startNew = useCallback(() => { userChose.current = true; setSelected(undefined); setMinted(undefined); }, []);
  const selectThread = useCallback((id: string) => { userChose.current = true; setSelected(id); setMinted(undefined); }, []);
  // Deleting the active conversation drops back to the landing; the hook's own
  // refresh re-lists, and the auto-select effect may then re-adopt the newest.
  const deleteThread = useCallback((id: string) => {
    void (async () => {
      try {
        await remove(id as Parameters<typeof remove>[0]);
      } catch {
        // A failed delete leaves the row in place — the list re-lists on the
        // next poll; nothing to surface for this quiet, reversible action.
        return;
      }
      setSelected(current => (current === id ? undefined : current));
      setMinted(current => (current === id ? undefined : current));
    })();
  }, [remove]);
  // ENG-222 — a conversation started via "New conversation" mints a thr_ the
  // sidebar list has never seen; refresh so it appears (and highlights). The
  // mint arrives at turn START while the row persists at turn END, and every
  // refresh replaces `threads` with a fresh array — so a list that still lacks
  // the id re-arms a SLOW timer instead of re-firing immediately (which would
  // hot-loop GET /threads at network-RTT cadence for the whole turn).
  const refreshedForRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (minted === undefined || threads.some(thread => thread.id === minted)) return;
    if (refreshedForRef.current !== minted) {
      refreshedForRef.current = minted;
      void refresh();
      return;
    }
    const timer = setTimeout(() => void refresh(), MINTED_RETRY_MS);
    return () => clearTimeout(timer);
  }, [minted, threads, refresh]);
  return (
    <div
      className="fl-page-pane"
      style={{
        display: "grid",
        // Desktop columns are split by the rail's own right-edge divider, so the
        // track gap collapses to 0 and the breathing room lives in the rail's
        // padding-right + the chat column's padding-left (equal, on either side
        // of the hairline). The mobile takeover keeps a real gap between the
        // stacked rail and thread.
        gap: takeover.active ? 14 : 0,
        // ENG-228: the sidebar+thread two-column grid is what crushed the
        // thread to one character per line at 375px — below the breakpoint
        // the conversation list stacks above a full-width thread.
        gridTemplateColumns: takeover.active ? "minmax(0, 1fr)" : "minmax(180px, 240px) minmax(0, 1fr)",
        // The single content row fills the pane so the rail and thread both run
        // full-height and the composer sits flush at the bottom — no dead space.
        gridTemplateRows: takeover.active ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)",
        // No bottom padding in the desktop layout: the chat column runs to the
        // pane's bottom edge and the composer's own 16px margin is the only gap
        // beneath it, so it sits flush at the bottom instead of floating high.
        padding: takeover.active ? 14 : "14px 14px 0",
      }}
    >
      <ConversationList
        threads={threads}
        activeId={activeId}
        onSelect={selectThread}
        onNew={startNew}
        onDelete={deleteThread}
        divided={!takeover.active}
      />
      {/* ENG-225 — the waiting-on-you strip parks above the live conversation;
          it renders nothing while no approvals are pending. */}
      <div
        className={takeover.active ? undefined : "fl-chat-col"}
        style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}
      >
        <WaitingQueue />
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {/* Discoverability gate (§6): this thread mounts with threadId
              undefined BEFORE the list resolves, and the auto-select effect
              lands a render later — both transients would burn (or flash) the
              one-time greeting for a returning user who is about to be snapped
              to their latest conversation. Hold the dial quiet until the
              surface has SETTLED on a genuinely fresh thread: list resolved
              with no conversations (a FAILED list proves nothing — the empty
              array is just the initial value, so an error keeps the gate
              shut), or an explicit user choice (userChose is set
              synchronously before the click's re-render). */}
          <VendoThread
            threadId={selected}
            onThreadId={onThreadId}
            {...(thread?.suggestions === undefined ? {} : { suggestions: thread.suggestions })}
            {...(thread?.greeting === undefined ? {} : { greeting: thread.greeting })}
            {...(thread?.intro === undefined ? {} : { intro: thread.intro })}
            {...(thread?.heroEyebrow === undefined ? {} : { heroEyebrow: thread.heroEyebrow })}
            {...(thread?.heroIcon === undefined ? {} : { heroIcon: thread.heroIcon })}
            discoverability={
              thread?.discoverability
                ?? (userChose.current || (!isLoading && threadsError === undefined && threads.length === 0)
                  ? undefined
                  : "quiet")
            }
          />
        </div>
      </div>
    </div>
  );
}

function OpenApp({ appId }: { appId: string }) {
  const { client, components } = useVendoContext();
  const { surface, refresh } = useApp(appId);
  // Wave 7 H2 — same keepalive as VendoSlot's MountedApp (see frames.tsx).
  const keepalive = useMemo(
    () => ({ ping: () => client.apps.pingMachine(appId), reopen: refresh }),
    [appId, client, refresh],
  );
  if (!surface) return <div role="status">Opening app…</div>;
  return <AppFrame key={appId} surface={surface} components={components} keepalive={keepalive} onAction={({ action, payload }) => client.apps.call(appId, action, payload ?? {})} />;
}

function AppsWorkspace() {
  const { apps, create, fork, remove } = useApps();
  const [selected, setSelected] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string>();
  const during = async (action: () => Promise<void>) => {
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = prompt.trim();
    if (!value) return;
    await during(async () => {
      const app = await create(value);
      setPrompt("");
      setSelected(app.id);
    });
  };
  return (
    <div className="fl-page-pane" style={{ gap: 14, overflowY: "auto", padding: 14 }}>
      {error ? <div role="alert" className="fl-error">{error}</div> : null}
      <form className="fl-picker-toprow" aria-label="Create app" onSubmit={event => void submit(event)}>
        <label style={{ flex: 1 }}>
          <span className="fl-picker-group" style={{ display: "block", margin: "0 2px 7px" }}>Describe a new app</span>
          <input className="fl-picker-search" value={prompt} onChange={event => setPrompt(event.currentTarget.value)} />
        </label>
        <button className="fl-btn fl-btn-primary" type="submit" disabled={!prompt.trim()}>Create</button>
      </form>
      <div className="fl-picker-grid">
        {apps.map(app => (
          <article
            className="fl-picker-item fl-automation"
            key={app.id}
            style={{ alignItems: "stretch", flexDirection: "column", padding: 0 }}
          >
            <div className="fl-auto-head">
              <span className="fl-auto-ic" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="7" height="7" x="3" y="3" rx="1" />
                  <rect width="7" height="7" x="14" y="3" rx="1" />
                  <rect width="7" height="7" x="3" y="14" rx="1" />
                  <rect width="7" height="7" x="14" y="14" rx="1" />
                </svg>
              </span>
              <div>
                <strong className="fl-auto-title">{app.name}</strong>
                {app.description ? <p className="fl-auto-sub" style={{ marginBottom: 0 }}>{app.description}</p> : null}
              </div>
            </div>
            <div className="fl-auto-flow" style={{ gap: 8 }}>
              <button className="fl-btn fl-btn-primary" type="button" onClick={() => setSelected(app.id)}>Open</button>
              <button className="fl-btn" type="button" onClick={() => void during(async () => { await fork(app.id); })}>Fork</button>
              <button className="fl-btn fl-btn-ceremony" type="button" onClick={() => {
                if (globalThis.confirm?.(`Remove ${app.name}?`)) {
                  void during(async () => {
                    await remove(app.id);
                    if (selected === app.id) setSelected(undefined);
                  });
                }
              }}>Remove</button>
            </div>
          </article>
        ))}
      </div>
      {selected ? <section className="fl-glass" aria-label="Open app"><OpenApp key={selected} appId={selected} /></section> : null}
    </div>
  );
}

/** 08-ui §4 — full workspace with WAI-ARIA automatic-activation tabs. */
export function VendoPage({ thread }: VendoPageProps = {}) {
  const takeover = useMobileTakeover();
  const [tab, setTab] = useState<Tab>("chat");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Lane pick 4-C — the Activity tab is the morph's dock anchor: the approved
  // pill shrinks into it and this pulse answers, teaching where receipts live.
  const [activityBump, setActivityBump] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const onBump = () => {
      setActivityBump(false);
      requestAnimationFrame(() => setActivityBump(true));
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => setActivityBump(false), 700);
    };
    window.addEventListener(ACTIVITY_BUMP_EVENT, onBump);
    return () => {
      window.removeEventListener(ACTIVITY_BUMP_EVENT, onBump);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    setTab(TABS[next]!);
    tabRefs.current[next]?.focus();
  };

  return (
    <ChromeRoot>
      {/* ENG-228: below the breakpoint the page covers the host viewport
          (`.fl-takeover`) instead of fighting the host layout for width,
          portaled to body so transformed host ancestors cannot capture it. */}
      <TakeoverPortal active={takeover.active}>
      <main
        className={`fl-page${takeover.active ? " fl-takeover" : ""}`}
        style={takeover.style}
        aria-label="Vendo workspace"
      >
        <div className="fl-tabbar" role="tablist" aria-label="Workspace sections">
          {TABS.map((item, index) => (
            <button
              ref={node => { tabRefs.current[index] = node; }}
              className={`fl-tab${item === "activity" && activityBump ? " fl-tab--bump" : ""}`}
              id={`vendo-tab-${item}`}
              type="button"
              role="tab"
              aria-selected={tab === item}
              aria-controls={`vendo-panel-${item}`}
              tabIndex={tab === item ? 0 : -1}
              key={item}
              onClick={() => setTab(item)}
              onKeyDown={event => move(event, index)}
              {...(item === "activity" ? { [ACTIVITY_ANCHOR_ATTRIBUTE]: "" } : {})}
            >{title(item)}</button>
          ))}
        </div>
        <div className="fl-page-body">
          <section className="fl-page-pane" id={`vendo-panel-${tab}`} role="tabpanel" aria-labelledby={`vendo-tab-${tab}`}>
            {tab === "chat" ? <ChatWorkspace thread={thread} /> : null}
            {tab === "apps" ? <AppsWorkspace /> : null}
            {tab === "automations" ? <AutomationsPanel /> : null}
            {tab === "accounts" ? <ConnectedAccountsPanel /> : null}
            {tab === "activity" ? <ActivityPanel /> : null}
          </section>
        </div>
      </main>
      </TakeoverPortal>
    </ChromeRoot>
  );
}

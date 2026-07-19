import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useVendoContext } from "../context.js";
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
import { VendoThread } from "./thread/index.js";
import { WaitingQueue } from "./waiting-queue.js";

const TABS = ["chat", "apps", "automations", "accounts", "activity"] as const;
type Tab = typeof TABS[number];

function title(tab: Tab): string {
  return tab[0]!.toUpperCase() + tab.slice(1);
}

function ChatWorkspace() {
  const takeover = useMobileTakeover();
  const { threads, isLoading, error: threadsError, refresh } = useThreads();
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
  // ENG-222 — a conversation started via "New conversation" mints a thr_ the
  // sidebar list has never seen; refresh so it appears (and highlights). Once
  // the refreshed list carries it the guard falls false, so this can't loop.
  useEffect(() => {
    if (minted !== undefined && !threads.some(thread => thread.id === minted)) {
      void refresh();
    }
  }, [minted, threads, refresh]);
  return (
    <div
      className="fl-page-pane"
      style={{
        display: "grid",
        gap: 14,
        // ENG-228: the sidebar+thread two-column grid is what crushed the
        // thread to one character per line at 375px — below the breakpoint
        // the conversation list stacks above a full-width thread.
        gridTemplateColumns: takeover.active ? "minmax(0, 1fr)" : "minmax(180px, 240px) minmax(0, 1fr)",
        gridTemplateRows: takeover.active ? "auto minmax(0, 1fr)" : undefined,
        padding: 14,
      }}
    >
      <nav
        className="fl-picker"
        aria-label="Conversations"
        style={{ alignSelf: "stretch", display: "flex", flexDirection: "column", gap: 8, maxHeight: "none", maxWidth: "none", padding: 12 }}
      >
        <button type="button" className="fl-btn fl-btn-primary" onClick={() => { userChose.current = true; setSelected(undefined); setMinted(undefined); }}>New conversation</button>
        {threads.map(thread => (
          <button
            type="button"
            className={`fl-btn${activeId === thread.id ? " fl-btn-primary" : ""}`}
            aria-current={activeId === thread.id ? "page" : undefined}
            key={thread.id}
            onClick={() => { userChose.current = true; setSelected(thread.id); setMinted(undefined); }}
            style={{ justifyContent: "flex-start", textAlign: "left" }}
          >{thread.title}</button>
        ))}
      </nav>
      {/* ENG-225 — the waiting-on-you strip parks above the live conversation;
          it renders nothing while no approvals are pending. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
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
            discoverability={
              userChose.current || (!isLoading && threadsError === undefined && threads.length === 0)
                ? undefined
                : "quiet"
            }
          />
        </div>
      </div>
    </div>
  );
}

function OpenApp({ appId }: { appId: string }) {
  const { client, components } = useVendoContext();
  const { surface } = useApp(appId);
  if (!surface) return <div role="status">Opening app…</div>;
  return <AppFrame key={appId} surface={surface} components={components} onAction={({ action, payload }) => client.apps.call(appId, action, payload ?? {})} />;
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
export function VendoPage() {
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
            {tab === "chat" ? <ChatWorkspace /> : null}
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

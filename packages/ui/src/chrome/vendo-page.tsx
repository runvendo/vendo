import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useApps } from "../hooks/use-apps.js";
import { useMobileTakeover } from "../hooks/use-mobile-takeover.js";
import { useThreads } from "../hooks/use-threads.js";
import { ActivityPanel } from "./activity-panel.js";
import { AutomationsPanel } from "./automations-panel.js";
import { AppsPage } from "./center/apps-page.js";
import { AppShelf } from "./center/home.js";
import { CENTER_PANEL_ID, CenterChats, CenterHeader, CenterSheet, NeedsYou, RailNav, centerViewLabel, railRows, type CenterView } from "./center/rail.js";
import { ChromeRoot } from "./chrome-root.js";
import { ConnectedAccountsPanel } from "./connected-accounts-panel.js";
import { LauncherToast, useLauncherStatus } from "./launcher-status.js";
import { ACTIVITY_BUMP_EVENT } from "./morph-toast.js";
import { IDLE_RUN_ACTIVITY, runActivity, subscribeRunActivity } from "./run-activity.js";
import { PrefillScopeContext } from "./overlay-registry.js";
import { TakeoverPortal } from "./takeover-portal.js";
import { VendoThread, type VendoThreadProps } from "./thread/index.js";
import { WaitingQueue } from "./waiting-queue.js";

/** Host passthrough for the conversation column — the same starter cards and
    discoverability dial a standalone VendoThread takes, so a host's curated
    landing survives the move onto the center. The center renders `suggestions`
    as ROWS (spec §10: noticings with icons, never generic chips) and reuses the
    same prompts as the day-zero ghost shelf (§14). */
export interface VendoPageProps {
  thread?: Pick<VendoThreadProps, "suggestions" | "discoverability">;
}

// How long a minted-thread rail retry waits before re-polling GET /threads
// (the mint header lands at turn START; the thread row persists at turn END).
const MINTED_RETRY_MS = 1_000;

/** The conversation the column is showing, and the rail's list of them. */
function useConversations() {
  const { threads, isLoading, error, refresh } = useThreads();
  const [selected, setSelected] = useState<string>();
  // ENG-222 — the thr_ the server mints for a "New chat" turn. Tracked
  // separately from `selected` (which drives VendoThread's threadId prop) so a
  // fresh mint highlights the rail without remounting the live conversation.
  const [minted, setMinted] = useState<string>();
  const activeId = selected ?? minted;
  // Default to the most recent conversation until the user makes an explicit
  // choice. `userChose` is set synchronously in the row handlers so that an
  // explicit "New chat" (selected → undefined) can never be clobbered by this
  // effect — which, being passive, may flush AFTER the click and would
  // otherwise resurrect the previous thread via `?? threads[0]` (ENG-222).
  const userChose = useRef(false);
  useEffect(() => {
    if (userChose.current || threads.length === 0) return;
    setSelected(current => current ?? threads[0]?.id);
  }, [threads]);
  const onThreadId = useCallback((id: string) => setMinted(id), []);
  // ENG-222 — a conversation started via "New chat" mints a thr_ the rail has
  // never seen; refresh so it appears (and highlights). The mint arrives at turn
  // START while the row persists at turn END, and every refresh replaces
  // `threads` with a fresh array — so a list that still lacks the id re-arms a
  // SLOW timer instead of re-firing immediately (which would hot-loop
  // GET /threads at network-RTT cadence for the whole turn).
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
  const choose = useCallback((id: string | undefined) => {
    userChose.current = true;
    setSelected(id);
    setMinted(undefined);
  }, []);
  // Discoverability gate (§6) AND the home gate: this column mounts with
  // threadId undefined BEFORE the list resolves, and the auto-select effect
  // lands a render later — both transients would burn (or flash) the one-time
  // greeting, and would flash the app shelf, for a returning user who is about
  // to be snapped to their latest conversation. Hold both quiet until the
  // surface has SETTLED on a genuinely fresh thread: a RESOLVED list (a failed
  // one proves nothing — the empty array is just the initial value) that either
  // has no conversations at all or that the user has explicitly left for a new
  // one. The health of the list is a precondition of both: an explicit New chat
  // against an erroring list is not evidence of a first-ever conversation, and
  // the once-per-user-ever greeting must never be burned on a guess.
  const settledFresh = !isLoading && error === undefined
    && (userChose.current || threads.length === 0);
  return { threads, selected, activeId, onThreadId, choose, settledFresh };
}

/** 08-ui §4 — the AI center (spec §10 pick X1): an in-page rail beside one
    column. Not an app frame: §12's standing law is that the host's own chrome
    surrounds us, so there is no brand row and no user row here, and §13 keeps
    the center and the overlay panel strangers — no cross-links either way. */
export function VendoPage({ thread }: VendoPageProps = {}) {
  const takeover = useMobileTakeover();
  const [view, setView] = useState<CenterView>("chat");
  const [moreOpen, setMoreOpen] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(false);
  const conversation = useConversations();
  const appsApi = useApps();
  // The center's prefill scope: a ghost tile's prompt lands in THIS column's
  // composer, never in whichever composer happened to mount last (§13).
  const scope = useMemo(() => Symbol("vendo-center"), []);
  // Lane pick 4-C — the Activity row is the morph's dock anchor: the approved
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

  // The home (§10 pick HB): a fresh conversation with no turn yet. It is the
  // thread's own landing — greeting, suggestion rows, composer — with the app
  // shelf mounted in the composer's accessory seam, so sending the first
  // message never relocates anything.
  const home = conversation.activeId === undefined && conversation.settledFresh;
  // Which app is open full in the column. Lifted to the page so a tap on the
  // home shelf lands on the Apps door with that app open — the rail always says
  // where you are.
  const [opened, setOpened] = useState<string>();
  const openApp = useCallback((appId: string) => {
    setView("apps");
    setChatsOpen(false);
    setOpened(appId);
  }, []);

  // One apps list feeds the shelf and the Apps door. A build that lands
  // mid-conversation would otherwise leave both stale, so re-read the list on
  // every ARRIVAL at either of them — a boolean "am I looking at apps" cannot
  // tell the shelf→door hop from standing still, and silently skipped the
  // refresh (proof round 1: the ghosts survived a real build).
  const station = view === "apps" ? "apps" : view === "chat" && home ? "home" : "elsewhere";
  const arrivedAt = useRef(station);
  const refreshApps = appsApi.refresh;
  useEffect(() => {
    // useResource already fetched on mount; only transitions refresh.
    if (station !== arrivedAt.current && station !== "elsewhere") void refreshApps();
    arrivedAt.current = station;
  }, [station, refreshApps]);

  // Navigating from the mobile history sheet unmounts the sheet the user's focus
  // was standing in. The column they just chose is where they land — the sheet
  // itself only restores focus to its opener when it is DISMISSED. Synchronous
  // (before the commit that removes the sheet) so nothing has to chase it.
  const panel = useRef<HTMLDivElement>(null);
  const landInColumn = useCallback(() => {
    if (chatsOpen) panel.current?.focus();
  }, [chatsOpen]);
  const goto = useCallback((next: CenterView) => {
    landInColumn();
    setView(next);
    setChatsOpen(false);
    // "New chat" is both the door to the column and the act of starting over —
    // the ChatGPT gesture, and the one every host's users already know.
    if (next === "chat") conversation.choose(undefined);
  }, [conversation, landInColumn]);
  const select = useCallback((id: string) => {
    landInColumn();
    conversation.choose(id);
    setView("chat");
    setChatsOpen(false);
  }, [conversation, landInColumn]);
  const openConversation = useCallback(() => {
    landInColumn();
    setView("chat");
    setChatsOpen(false);
  }, [landInColumn]);

  // What the center says about a run the user has walked away from (§2 G1: the
  // panel's promise, which the center never kept — LauncherToast and the run
  // narration were overlay-only, so a turn that finished while the user was on
  // Apps or Automations finished in silence). Same hook, same store; "open" here
  // means the conversation column is what they are actually looking at.
  const looking = view === "chat" && !chatsOpen;
  const status = useLauncherStatus({
    open: looking,
    ...(conversation.activeId === undefined ? {} : { threadId: conversation.activeId }),
    onOpen: openConversation,
  });
  // Which conversation row pulses. The store knows a turn is live; the page
  // knows whose it is.
  const activity = useSyncExternalStore(subscribeRunActivity, runActivity, () => IDLE_RUN_ACTIVITY);
  const runningId = activity.running ? conversation.activeId : undefined;

  // The shelf rides the composer's accessory seam, and ONLY while the column is
  // actually showing: every tile is a real mounted app, so a shelf sitting
  // behind another door would boot machines nobody is looking at.
  const shelf = home && view === "chat"
    ? (
      <AppShelf
        apps={appsApi.apps}
        onOpen={openApp}
        {...(thread?.suggestions === undefined ? {} : { suggestions: thread.suggestions })}
        scope={scope}
      />
    )
    : null;

  const chats = (
    <>
      {/* §4 — the numbered attention section, present only while asks wait. */}
      <NeedsYou onOpen={openConversation} />
      <CenterChats
        threads={conversation.threads}
        activeId={conversation.activeId}
        runningId={runningId}
        onSelect={select}
      />
    </>
  );

  return (
    <ChromeRoot>
      {/* ENG-228: below the breakpoint the page covers the host viewport
          (`.fl-takeover`) instead of fighting the host layout for width,
          portaled to body so transformed host ancestors cannot capture it. */}
      <TakeoverPortal active={takeover.active}>
      {/* §12 — the center is a PAGE INSIDE the host's app, so the host's own
          <main> is the document's main landmark. This used to be a second one,
          which is a landmark the host never asked for and a duplicate for anyone
          navigating by landmark. A named region is what we actually are. */}
      <section
        className={`fl-page fl-center${takeover.active ? " fl-center--mobile fl-takeover" : ""}`}
        style={takeover.style}
        aria-label="Vendo workspace"
      >
        {takeover.active
          ? <CenterHeader view={view} onView={goto} onChats={() => setChatsOpen(open => !open)} chatsOpen={chatsOpen} />
          : (
            <nav className="fl-rail" aria-label="Assistant">
              <RailNav view={view} onView={goto} moreOpen={moreOpen} onMoreOpen={setMoreOpen} activityBump={activityBump} />
              {chats}
            </nav>
          )}
        <div
          className="fl-center-main"
          ref={panel}
          tabIndex={-1}
          {...(takeover.active
            ? {}
            : {
              role: "tabpanel",
              id: CENTER_PANEL_ID,
              // The tab that labels the panel has to still BE there: closing the
              // ··· row while Activity is open takes its tab away, and an
              // aria-labelledby pointing at a removed id leaves the panel
              // nameless. Then the panel names itself.
              ...(railRows(moreOpen).includes(view)
                ? { "aria-labelledby": `vendo-tab-${view}` }
                : { "aria-label": centerViewLabel(view) }),
            })}
        >
          {/* The spoken half of a run the user has walked away from: the pill's
              narration, for a surface that has no pill. */}
          <p className="fl-sr-only" role="status">{status.working ? `${status.label}…` : ""}</p>
          {/* The conversation stays MOUNTED behind the other doors: visiting
              Apps must not abandon a running turn (or lose the transcript). */}
          <div className="fl-center-col" hidden={view !== "chat"}>
            {/* ENG-225 — the waiting-on-you strip parks above the live
                conversation; it renders nothing while no approvals pend. */}
            <WaitingQueue />
            <div className={`fl-center-thread${home ? " fl-center-home" : ""}`}>
              <PrefillScopeContext.Provider value={scope}>
                {/* keyed on the conversation: switching threads is a NEW
                    conversation surface, and re-using the instance handed the
                    next thread a live transport still streaming the last one's
                    turn — the running turn's UI simply went missing. */}
                <VendoThread
                  key={conversation.selected ?? "new"}
                  threadId={conversation.selected}
                  onThreadId={conversation.onThreadId}
                  {...(thread?.suggestions === undefined ? {} : { suggestions: thread.suggestions })}
                  discoverability={thread?.discoverability ?? (conversation.settledFresh ? undefined : "quiet")}
                  {...(shelf === null ? {} : { composerAccessory: shelf })}
                />
              </PrefillScopeContext.Provider>
            </div>
          </div>
          {view === "apps"
            ? <AppsPage api={appsApi} opened={opened} onOpened={setOpened} />
            : null}
          {view === "automations" ? <div className="fl-center-page"><AutomationsPanel /></div> : null}
          {view === "activity" ? <div className="fl-center-page"><ActivityPanel /></div> : null}
          {view === "accounts" ? <div className="fl-center-page"><ConnectedAccountsPanel /></div> : null}
        </div>
        {takeover.active && chatsOpen
          ? <CenterSheet view={view} onView={goto} onClose={() => setChatsOpen(false)}>{chats}</CenterSheet>
          : null}
        {/* §3 H1 — the completion toast is the way back INTO the conversation
            that produced the result; the record itself stays the thread. Same
            component the overlay raises, so there is one of these, not two. */}
        {status.toast === undefined
          ? null
          : (
            <LauncherToast
              result={status.toast}
              position="bottom-right"
              onView={status.view}
              onDismiss={status.dismissToast}
            />
          )}
      </section>
      </TakeoverPortal>
    </ChromeRoot>
  );
}

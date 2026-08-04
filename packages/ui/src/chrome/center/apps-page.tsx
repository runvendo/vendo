/** The Apps door (redesign spec §10, pick T4 + named doors): the live-tile grid
 *  with room to breathe, a tap opening the app full in the column, and "ask
 *  below to build a new one" — the composer, not a dialog, is how apps are made.
 *
 *  Everything the old Apps TAB could do it can still do (change · fork · share ·
 *  remove, and §9.4's consumer-voice fork offer when a viewer is refused a
 *  change) — this is a restyle of a capable surface, not a smaller one.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useVendoContext } from "../../context.js";
import { useApp } from "../../hooks/use-app.js";
import { useApps } from "../../hooks/use-apps.js";
import { useVendoStatus } from "../../hooks/use-vendo-status.js";
import { AppFrame } from "../../tree/frames.js";
import { ForkOffer, ShareDialog } from "../share-dialog.js";
import { AppTile } from "./home.js";

/**
 * The consumer's half of a refusal, for the verbs THIS page has (design §3 — the
 * consumer-voice law). The page used to render `reason.message` verbatim, so
 * every developer-voice sentence the wire raises — "app not found: app_1", one
 * naming VENDO_API_KEY — was shown to whoever was using the app. The developer
 * sentence keeps its home (the server's own error, the browser console); the
 * person is told what it means for them. The Share dialog keeps its own
 * phase-aware twin (`refusalCopy` in share-dialog.tsx): "the move was refused"
 * and "the change was refused" are different sentences, and a shared generic one
 * would be worse copy than both.
 */
function refusalSentence(reason: unknown): string {
  const code = (reason as { code?: unknown } | null)?.code;
  // `forbidden` normally becomes the fork offer; this is the leg for the calls
  // that pass no app id to offer a fork OF — Create, and a fork that itself
  // came back refused.
  if (code === "forbidden") return "You can look at this app, but not change it.";
  if (code === "not-found") return "This app isn’t available any more.";
  if (code === "cloud-required") return "That isn’t turned on for this workspace yet.";
  return "That didn’t go through — nothing changed. Try again in a moment.";
}

/** An app open full in the column. `name` comes from the list the caller
 *  already has, so the region is named from its FIRST paint: naming it from the
 *  fetch renamed the landmark under the user a moment after they arrived (and
 *  told anyone who had just been moved into it that they were in "Open app"). */
export function OpenApp({ appId, name, onClose }: { appId: string; name?: string; onClose(): void }) {
  const { client, components } = useVendoContext();
  // The grid this replaced was where the keyboard was standing. Land in the app
  // that just opened — the region announces itself by name — instead of dropping
  // focus on <body> and making the user Tab in from the top of the page.
  const pane = useRef<HTMLElement>(null);
  useEffect(() => pane.current?.focus(), []);
  const { app, surface, error, isLoading, refresh } = useApp(appId);
  // Wave 7 H2 — same keepalive as VendoSlot's MountedApp (see frames.tsx).
  const keepalive = useMemo(
    () => ({ ping: () => client.apps.pingMachine(appId), reopen: refresh }),
    [appId, client, refresh],
  );
  const body = surface
    ? (
      <AppFrame
        key={appId}
        surface={surface}
        components={components}
        keepalive={keepalive}
        onAction={({ action, payload }) => client.apps.call(appId, action, payload ?? {})}
      />
    )
    // useApp has already spent its retries; without a way to ask again the pane
    // sat on "Opening app…" until a page reload (Keystone graduates A5).
    : error && !isLoading
      ? (
        <div role="alert" className="fl-error">
          {/* spec §16 law 3 — the wire's sentence is the developer's (one names
              an env var, another carries an app id); the pane says what it
              means for the person. */}
          This app didn’t open. {refusalSentence(error)}
          <button type="button" className="fl-error-retry" onClick={() => void refresh()}>Try again</button>
        </div>
      )
      : <div role="status">Opening app…</div>;
  return (
    <section className="fl-center-open" aria-label={name ?? "Open app"} tabIndex={-1} ref={pane}>
      <div className="fl-center-open-top">
        <button type="button" className="fl-btn" onClick={onClose}>← All apps</button>
        <span className="fl-center-open-name">{name ?? app?.name}</span>
      </div>
      {body}
    </section>
  );
}

export interface AppsPageProps {
  /** The page's apps transport, hoisted to VendoPage so the home shelf and this
   *  door read ONE list (and one fetch) rather than two that can disagree. */
  api: ReturnType<typeof useApps>;
  /** The app open full in the column, if any — lifted so a tap on the home
   *  shelf can open an app here. */
  opened: string | undefined;
  onOpened(appId: string | undefined): void;
}

export function AppsPage({ api, opened, onOpened }: AppsPageProps) {
  const { client } = useVendoContext();
  const { apps, create, fork, remove, refresh } = api;
  // §9.1 — the orgs the host asserted for this caller; the Share dialog offers
  // them by name. Empty on a single-player deployment, which is the point.
  // `namesPeople` is §9.1's companion: the host wired `resolvePerson`, so the
  // dialog may offer to share with one person. Unset, it must not — Vendo holds
  // no directory of its own.
  const { memberships, namesPeople } = useVendoStatus();
  const [sharing, setSharing] = useState<string>();
  /** §9.4 — the app whose CHANGE was refused, and what was asked for, so the
      fork offer can name it back ("…to make it dark — but I can make you your
      own"). */
  const [denied, setDenied] = useState<{ appId: string; instruction?: string }>();
  const [changing, setChanging] = useState<string>();
  const [instruction, setInstruction] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string>();
  // Coming BACK from an open app is a return, so focus returns with it: to the
  // tile that opened it when this page opened it, else to the page's own
  // heading (the home shelf can open an app here without the grid ever having
  // been on screen).
  const heading = useRef<HTMLHeadingElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const cameFrom = useRef<string>(undefined);
  // H-3 — CLOSING an app is the event, not "opened is undefined". `cameFrom`
  // is written by this page's own tile, so the two other ways in — a tap on the
  // home shelf and this page's own create field — left it unset and the effect
  // returned early: focus stayed on <body> and the keyboard had to Tab in from
  // the top of the host page. The heading fallback the comment above promises
  // was unreachable from either.
  const wasOpen = useRef(opened !== undefined);
  const open = (appId: string) => {
    cameFrom.current = appId;
    onOpened(appId);
  };
  useEffect(() => {
    const closed = wasOpen.current && opened === undefined;
    wasOpen.current = opened !== undefined;
    if (!closed) return;
    const from = cameFrom.current;
    cameFrom.current = undefined;
    const tile = from === undefined
      ? null
      : grid.current?.querySelector<HTMLElement>(`[data-vendo-tile="${from}"]`);
    (tile ?? heading.current)?.focus();
  }, [opened]);
  const during = async (action: () => Promise<void>, appId?: string, asked?: string) => {
    setError(undefined);
    setDenied(undefined);
    try {
      await action();
    } catch (reason) {
      // §9.4 — `forbidden` means they can see it but not do this to it, which
      // is answerable: offer the fork instead of showing them a wall. The code
      // is thrown ONLY to a proven viewer, which is what makes the offer safe.
      if (appId !== undefined && (reason as { code?: string })?.code === "forbidden") {
        setDenied({ appId, ...(asked === undefined ? {} : { instruction: asked }) });
        return;
      }
      setError(refusalSentence(reason));
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = prompt.trim();
    if (!value) return;
    await during(async () => {
      const app = await create(value);
      setPrompt("");
      onOpened(app.id);
    });
  };

  if (opened !== undefined) {
    const name = apps.find(app => app.id === opened)?.name;
    return (
      <OpenApp
        key={opened}
        appId={opened}
        {...(name === undefined ? {} : { name })}
        onClose={() => onOpened(undefined)}
      />
    );
  }

  return (
    <div className="fl-center-page">
      <h2 className="fl-center-title" tabIndex={-1} ref={heading}>Apps</h2>
      <p className="fl-center-cap">Tap one to open it — or ask below to build a new one.</p>
      {error ? <div role="alert" className="fl-error">{error}</div> : null}
      {apps.length === 0 ? <p className="fl-center-empty">Nothing yet — anything you build lands here, live.</p> : null}
      <div className="fl-shelf fl-shelf--grid" ref={grid}>
        {apps.map(app => (
          <AppTile app={app} key={app.id} onOpen={() => open(app.id)}>
            <span className="fl-tile-acts">
              {/* §9.4 — the EDIT path is the one `forbidden` was invented for: a
                  viewer who asks for a change gets the consumer-voice fork offer
                  instead of a refusal. */}
              <button className="fl-tile-act" type="button" onClick={() => { setChanging(changing === app.id ? undefined : app.id); setInstruction(""); }}>
                {changing === app.id ? "Cancel change" : "Change"}
              </button>
              <button className="fl-tile-act" type="button" onClick={() => void during(async () => { await fork(app.id); })}>Fork</button>
              {/* Build contract §9.2-§9.6 — the Share dialog is the ONE surface
                  that writes grants. It opens for anyone; the dialog itself
                  reads the caller's level and says plainly when they may not
                  change who reaches the app. */}
              <button className="fl-tile-act" type="button" onClick={() => setSharing(sharing === app.id ? undefined : app.id)}>
                {sharing === app.id ? "Close sharing" : "Share"}
              </button>
              <button className="fl-tile-act fl-tile-act--ceremony" type="button" onClick={() => {
                if (globalThis.confirm?.(`Remove ${app.name}?`)) {
                  void during(async () => {
                    await remove(app.id);
                    if (opened === app.id) onOpened(undefined);
                  }, app.id);
                }
              }}>Remove</button>
            </span>
            {/* The answer belongs beside the question: the offer is about THIS
                app, so it renders in this tile rather than at the top of the
                page, where it read as a page-level announcement. */}
            {denied?.appId === app.id ? (
              <ForkOffer
                {...(denied.instruction === undefined ? {} : { instruction: denied.instruction })}
                // The copy lands as its own LIVE tile in this grid — visible
                // proof without navigating away from what they were doing. (The
                // old page opened it in a pane below the grid; in the center,
                // opening replaces the grid, which is too big a move to make
                // on someone's behalf.)
                onFork={() => during(async () => {
                  await fork(app.id);
                  setDenied(undefined);
                })}
                onDismiss={() => setDenied(undefined)}
              />
            ) : null}
            {changing === app.id ? (
              <form
                className="fl-tile-form"
                aria-label={`Change ${app.name}`}
                onSubmit={event => {
                  event.preventDefault();
                  const asked = instruction.trim();
                  if (!asked) return;
                  void during(async () => {
                    await client.apps.edit(app.id, asked);
                    setInstruction("");
                    setChanging(undefined);
                    await refresh();
                  }, app.id, asked);
                }}
              >
                <input className="fl-picker-search" aria-label={`What should change about ${app.name}?`} value={instruction} onChange={event => setInstruction(event.currentTarget.value)} />
                <button className="fl-btn fl-btn-primary" type="submit" disabled={!instruction.trim()}>Save</button>
              </form>
            ) : null}
            {sharing === app.id ? (
              <ShareDialog
                appId={app.id}
                appName={app.name}
                memberships={memberships}
                namesPeople={namesPeople}
                // §9.5 — an app that declares a trigger loses it in the move;
                // the dialog says so before and after.
                automation={app.trigger !== undefined}
                onClose={() => setSharing(undefined)}
              />
            ) : null}
          </AppTile>
        ))}
      </div>
      {/* "ask below": the page's own one-line ask, in the composer's slot at the
          bottom of the column, so building an app never means finding a menu. */}
      <form className="fl-center-ask" aria-label="Create app" onSubmit={event => void submit(event)}>
        <label className="fl-center-ask-field">
          <span className="fl-picker-group">Describe a new app</span>
          <input className="fl-picker-search" value={prompt} onChange={event => setPrompt(event.currentTarget.value)} />
        </label>
        <button className="fl-btn fl-btn-primary" type="submit" disabled={!prompt.trim()}>Create</button>
      </form>
    </div>
  );
}

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useVendoContext } from "../context.js";
import { useApp } from "../hooks/use-app.js";
import { useApps } from "../hooks/use-apps.js";
import { AppFrame } from "../tree/frames.js";
import type { ThreadSummary } from "../wire-types.js";
import { ActivityPanel } from "./activity-panel.js";
import { AutomationsPanel } from "./automations-panel.js";
import { ChromeRoot } from "./chrome-root.js";
import { VendoThread } from "./vendo-thread.js";

const TABS = ["chat", "apps", "automations", "activity"] as const;
type Tab = typeof TABS[number];

function title(tab: Tab): string {
  return tab[0]!.toUpperCase() + tab.slice(1);
}

function ChatWorkspace() {
  const { client } = useVendoContext();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selected, setSelected] = useState<string>();
  useEffect(() => {
    let active = true;
    void client.threads.list().then(items => {
      if (!active) return;
      setThreads(items);
      setSelected(current => current ?? items[0]?.id);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [client]);
  return (
    <div
      className="fl-page-pane"
      style={{ display: "grid", gap: 14, gridTemplateColumns: "minmax(180px, 240px) minmax(0, 1fr)", padding: 14 }}
    >
      <nav
        className="fl-picker"
        aria-label="Conversations"
        style={{ alignSelf: "stretch", display: "flex", flexDirection: "column", gap: 8, maxHeight: "none", maxWidth: "none", padding: 12 }}
      >
        <button type="button" className="fl-btn fl-btn-primary" onClick={() => setSelected(undefined)}>New conversation</button>
        {threads.map(thread => (
          <button
            type="button"
            className={`fl-btn${selected === thread.id ? " fl-btn-primary" : ""}`}
            aria-current={selected === thread.id ? "page" : undefined}
            key={thread.id}
            onClick={() => setSelected(thread.id)}
            style={{ justifyContent: "flex-start", textAlign: "left" }}
          >{thread.title}</button>
        ))}
      </nav>
      <VendoThread threadId={selected} />
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
          <article className="fl-automation" key={app.id}>
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
  const [tab, setTab] = useState<Tab>("chat");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

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
      <main className="fl-page" aria-label="Vendo workspace">
        <div className="fl-tabbar" role="tablist" aria-label="Workspace sections">
          {TABS.map((item, index) => (
            <button
              ref={node => { tabRefs.current[index] = node; }}
              className="fl-tab"
              id={`vendo-tab-${item}`}
              type="button"
              role="tab"
              aria-selected={tab === item}
              aria-controls={`vendo-panel-${item}`}
              tabIndex={tab === item ? 0 : -1}
              key={item}
              onClick={() => setTab(item)}
              onKeyDown={event => move(event, index)}
            >{title(item)}</button>
          ))}
        </div>
        <div className="fl-page-body">
          <section className="fl-page-pane" id={`vendo-panel-${tab}`} role="tabpanel" aria-labelledby={`vendo-tab-${tab}`}>
            {tab === "chat" ? <ChatWorkspace /> : null}
            {tab === "apps" ? <AppsWorkspace /> : null}
            {tab === "automations" ? <AutomationsPanel /> : null}
            {tab === "activity" ? <ActivityPanel /> : null}
          </section>
        </div>
      </main>
    </ChromeRoot>
  );
}

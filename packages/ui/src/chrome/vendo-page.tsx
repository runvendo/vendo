import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useVendoContext } from "../context.js";
import { useApp } from "../hooks/use-app.js";
import { useApps } from "../hooks/use-apps.js";
import { AppFrame } from "../tree/frames.js";
import type { ThreadSummary } from "../wire-types.js";
import { ActivityPanel } from "./activity-panel.js";
import { AutomationsPanel } from "./automations-panel.js";
import { ChromeRoot } from "./chrome-root.js";
import { NoPolicyNotice } from "./no-policy-notice.js";
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
    <div className="vendo-page-grid">
      <nav className="vendo-card vendo-stack" aria-label="Conversations">
        <button type="button" className="vendo-primary" onClick={() => setSelected(undefined)}>New conversation</button>
        {threads.map(thread => <button type="button" aria-current={selected === thread.id ? "page" : undefined} key={thread.id} onClick={() => setSelected(thread.id)}>{thread.title}</button>)}
      </nav>
      <VendoThread threadId={selected} />
    </div>
  );
}

function OpenApp({ appId }: { appId: string }) {
  const { client, components } = useVendoContext();
  const { surface } = useApp(appId);
  if (!surface) return <div role="status">Opening app…</div>;
  return <AppFrame surface={surface} components={components} onAction={({ action, payload }) => client.apps.call(appId, action, payload ?? {})} />;
}

function AppsWorkspace() {
  const { apps, create, fork, remove } = useApps();
  const [selected, setSelected] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = prompt.trim();
    if (!value) return;
    const app = await create(value);
    setPrompt("");
    setSelected(app.id);
  };
  return (
    <div className="vendo-stack">
      <form className="vendo-row" aria-label="Create app" onSubmit={event => void submit(event)}>
        <label style={{ flex: 1 }}><span className="vendo-muted">Describe a new app</span><input className="vendo-input" value={prompt} onChange={event => setPrompt(event.currentTarget.value)} /></label>
        <button className="vendo-primary" type="submit" disabled={!prompt.trim()}>Create</button>
      </form>
      <div className="vendo-app-grid">
        {apps.map(app => (
          <article className="vendo-card vendo-stack" key={app.id}>
            <strong>{app.name}</strong>
            {app.description ? <p>{app.description}</p> : null}
            <div className="vendo-row">
              <button type="button" onClick={() => setSelected(app.id)}>Open</button>
              <button type="button" onClick={() => void fork(app.id)}>Fork</button>
              <button className="vendo-danger" type="button" onClick={() => {
                if (globalThis.confirm?.(`Remove ${app.name}?`)) {
                  void remove(app.id);
                  if (selected === app.id) setSelected(undefined);
                }
              }}>Remove</button>
            </div>
          </article>
        ))}
      </div>
      {selected ? <section className="vendo-card" aria-label="Open app"><OpenApp appId={selected} /></section> : null}
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
      <main className="vendo-stack" aria-label="Vendo workspace">
        <NoPolicyNotice />
        <div className="vendo-tabs" role="tablist" aria-label="Workspace sections">
          {TABS.map((item, index) => (
            <button
              ref={node => { tabRefs.current[index] = node; }}
              className="vendo-tab"
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
        <section className="vendo-tabpanel" id={`vendo-panel-${tab}`} role="tabpanel" aria-labelledby={`vendo-tab-${tab}`}>
          {tab === "chat" ? <ChatWorkspace /> : null}
          {tab === "apps" ? <AppsWorkspace /> : null}
          {tab === "automations" ? <AutomationsPanel /> : null}
          {tab === "activity" ? <ActivityPanel /> : null}
        </section>
      </main>
    </ChromeRoot>
  );
}

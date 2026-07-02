"use client"

/**
 * Surface #2 — the full-page Flowlet tab. A proof point that the same agent
 * lives anywhere it's dropped, here as a dedicated page.
 *
 * The chat IS the page — ingrained directly into the surface, not a card floating
 * in whitespace. A tab strip is the top row: a live "Chat" thread, one auto-saved
 * tab per flowlet you've built, and a "+" to start fresh. The surface fills the
 * viewport below Maple's topbar; only the message list scrolls. This page keeps its
 * own thread (the floating dock + Cmd+K overlay share a separate one); the dock is
 * hidden on this route (see FlowletLayer).
 */
import { useEffect, useState } from "react"
import { FlowletThread, useFlowletThread, useShell, useReopenFlowlet, type Flowlet } from "@flowlet/shell"
import { FlowletRoot } from "@/components/flowlet/FlowletRoot"
import { deriveSavedDrafts } from "@/flowlet/saved-flowlets"

const SUGGESTIONS = [
  "What did I spend money on when I should've been asleep?",
  "What was that $87 DoorDash charge?",
  "Put me on blast in Slack when I order late-night delivery",
]

const CHAT = "chat"

function PageSurface() {
  const chat = useFlowletThread()
  const { store } = useShell()
  const [active, setActive] = useState<string>(CHAT)
  const [saved, setSaved] = useState<Flowlet[]>([])

  // Hydrate the tab strip from the store (ENG-183): saved flowlets survive
  // reloads. Oldest-first so tabs keep their creation order.
  useEffect(() => {
    let cancelled = false
    void store.list().then((all) => {
      if (!cancelled) setSaved(all.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)))
    })
    return () => { cancelled = true }
  }, [store])

  // Every rendered view in the thread becomes a saved flowlet (deduped by node
  // id), persisted through the store with the prompt that produced it. Saved
  // tabs survive a "+" reset that clears the live thread — and now reloads too.
  useEffect(() => {
    const drafts = deriveSavedDrafts(chat.items, new Set(saved.map((s) => s.id)))
    if (drafts.length === 0) return
    void Promise.all(drafts.map((d) => store.save(d)))
      .then((records) => {
        setSaved((prev) => [...prev, ...records.filter((r) => !prev.some((p) => p.id === r.id))])
      })
      // save() throws loud (quota/unavailable); an unhandled rejection here
      // would silently drop the tab. Log it; the next items change retries.
      .catch((error: unknown) => console.error("[flowlet] failed to persist saved view", error))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.items])

  const newChat = () => {
    chat.setMessages([])
    setActive(CHAT)
  }

  const activeSaved = saved.find((s) => s.id === active)

  return (
    <div className="fl-page">
      <div className="fl-tabbar" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={active === CHAT}
          className="fl-tab"
          onClick={() => setActive(CHAT)}
        >
          Chat
        </button>
        {saved.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={active === s.id}
            className="fl-tab"
            onClick={() => setActive(s.id)}
          >
            <span className="fl-tab-dot" aria-hidden />
            {s.name}
          </button>
        ))}
        <button type="button" className="fl-tab fl-tab-new" aria-label="New chat" onClick={newChat}>
          ＋
        </button>
      </div>

      <div className="fl-page-body">
        <div className="fl-page-pane" hidden={active !== CHAT}>
          <FlowletThread greeting="What do you want to build?" suggestions={SUGGESTIONS} />
        </div>
        {activeSaved ? <SavedPane key={activeSaved.id} flowlet={activeSaved} /> : null}
      </div>
    </div>
  )
}

/**
 * A reopened saved flowlet: renders the persisted snapshot instantly, then
 * re-runs the view's declared data queries through the policy-governed action
 * route (the RunQuery seam) and streams the fresh data in via the stage's
 * data-delta path. Query failures silently keep the snapshot (ENG-183 default:
 * live re-run with graceful fallback).
 */
function SavedPane({ flowlet }: { flowlet: Flowlet }) {
  const { renderNode } = useShell()
  const { node } = useReopenFlowlet(flowlet)
  return <div className="fl-saved-pane">{renderNode(node)}</div>
}

export default function FlowletTabPage() {
  // Bind the surface to the viewport so the message list scrolls internally and the
  // composer stays pinned, instead of the page growing with the thread. Maple's
  // shell is `min-h-screen` (no fixed height to inherit), so height:100% wouldn't
  // cap it — we subtract the sticky topbar (h-16 = 64px) and the main padding
  // (py-6 = 48px) explicitly.
  return (
    <div
      style={{
        height: "calc(100dvh - 112px)",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <FlowletRoot>
        <PageSurface />
      </FlowletRoot>
    </div>
  )
}

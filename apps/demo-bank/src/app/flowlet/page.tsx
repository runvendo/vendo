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
import { FlowletThread, useFlowletThread, useShell } from "@flowlet/shell"
import { stripEmoji, type UINode } from "@flowlet/core"
import { FlowletRoot } from "@/components/flowlet/FlowletRoot"

const SUGGESTIONS = [
  "What did I spend money on when I should've been asleep?",
  "What was that $87 DoorDash charge?",
  "Put me on blast in Slack when I order late-night delivery",
]

type ComponentNode = Extract<UINode, { kind: "component" }>
interface SavedTab { id: string; label: string; node: ComponentNode }

/** A readable tab label from a generated component node. */
function labelFor(node: ComponentNode): string {
  const props = (node.props && typeof node.props === "object" ? node.props : {}) as Record<string, unknown>
  if (node.name === "TimeOfDayClock") return "Time-of-day spending"
  if (typeof props.title === "string" && props.title.trim()) return stripEmoji(props.title)
  return node.name
}

const CHAT = "chat"

function PageSurface() {
  const chat = useFlowletThread()
  const { renderNode } = useShell()
  const [active, setActive] = useState<string>(CHAT)
  const [saved, setSaved] = useState<SavedTab[]>([])

  // Every generated component view in the thread becomes a saved tab (deduped by
  // node id). We only ever append, so saved tabs survive a "+" reset that clears
  // the live thread.
  useEffect(() => {
    setSaved((prev) => {
      const seen = new Set(prev.map((s) => s.id))
      const next = [...prev]
      for (const item of chat.items) {
        if (item.kind !== "ui" || item.node.kind !== "component") continue
        if (seen.has(item.node.id)) continue
        seen.add(item.node.id)
        next.push({ id: item.node.id, label: labelFor(item.node), node: item.node })
      }
      return next.length === prev.length ? prev : next
    })
  }, [chat.items])

  const newChat = () => {
    // Full reset: abort any in-flight run (a severed stream can leave status
    // stuck on "streaming") and drop stale error state along with the messages —
    // otherwise the old error banner haunts the fresh thread.
    chat.stop()
    chat.clearError()
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
            {s.label}
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
        {activeSaved ? (
          <div className="fl-saved-pane" key={activeSaved.id}>
            {renderNode(activeSaved.node)}
          </div>
        ) : null}
      </div>
    </div>
  )
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

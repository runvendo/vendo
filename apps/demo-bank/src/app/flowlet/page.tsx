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
import { FlowletThread, FlowletToast, useFlowletThread, useShell, useReopenFlowlet, type Flowlet } from "@flowlet/shell"
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

  // Library management (ENG-183 gate): rename + pin persist through the store;
  // delete is undoable via a toast (no confirm dialog), never destructive twice.
  // Deletes QUEUE (FIFO): each deleted view gets its own toast with a full
  // undo window — a rapid second delete must not orphan the first's undo.
  const [deleted, setDeleted] = useState<Flowlet[]>([])

  // Read-modify-write against the CURRENT store record: the gallery's `flow`
  // prop can be stale (the reopen hook writes fresh node data back), and a
  // rename spread from stale state would overwrite that fresh node.
  const persistPatch = (flow: Flowlet, patch: Partial<Flowlet>) => {
    void store
      .load(flow.id)
      .then((current) => {
        const { updatedAt: _prior, ...base } = current ?? flow
        return store.save({ ...base, ...patch })
      })
      .then((record) => setSaved((prev) => prev.map((p) => (p.id === record.id ? record : p))))
      .catch((error: unknown) => console.error("[flowlet] failed to update saved view", error))
  }

  const deleteFlow = (flow: Flowlet) => {
    void store
      .load(flow.id) // capture the CURRENT record so undo restores fresh data
      .then(async (current) => {
        await store.remove(flow.id)
        setSaved((prev) => prev.filter((p) => p.id !== flow.id))
        setActive((now) => (now === flow.id ? CHAT : now))
        setDeleted((queue) => [...queue, current ?? flow])
      })
      .catch((error: unknown) => console.error("[flowlet] failed to delete saved view", error))
  }

  const settleDelete = (flow: Flowlet, restore: boolean) => {
    setDeleted((queue) => queue.filter((f) => f.id !== flow.id))
    if (!restore) return
    void store
      .save(flow) // full record, original timestamps — restores exactly
      .then((record) =>
        setSaved((prev) =>
          [...prev, record].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
        ),
      )
      .catch((error: unknown) => console.error("[flowlet] failed to restore saved view", error))
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
          <FlowletThread
            greeting="What do you want to build?"
            suggestions={SUGGESTIONS}
            heroComposer
            flows={saved}
            onOpenFlow={(f) => setActive(f.id)}
            onRenameFlow={(f, name) => persistPatch(f, { name })}
            onPinFlow={(f, pinned) => persistPatch(f, { pinned })}
            onDeleteFlow={deleteFlow}
          />
        </div>
        {activeSaved ? <SavedPane key={activeSaved.id} flowlet={activeSaved} /> : null}
      </div>
      {deleted[0] && (
        <FlowletToast
          key={deleted[0].id} // per-view countdown: the next queued toast starts fresh
          message={`Deleted "${deleted[0].name}"`}
          onAction={() => settleDelete(deleted[0]!, true)}
          onDismiss={() => settleDelete(deleted[0]!, false)}
        />
      )}
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
  const { node, status, errors } = useReopenFlowlet(flowlet)
  return (
    <div className="fl-saved-pane">
      {/* Surfaced stale state (ENG-183 gate): quiet mono note when any query
          could not re-run (reads-only refusal, policy deny, network). */}
      {errors.length > 0 && status !== "live" && (
        <div className="fl-stale-note">showing saved data — live refresh unavailable</div>
      )}
      {renderNode(node)}
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
        position: "relative", // anchors the undo toast
      }}
    >
      <FlowletRoot>
        <PageSurface />
      </FlowletRoot>
    </div>
  )
}

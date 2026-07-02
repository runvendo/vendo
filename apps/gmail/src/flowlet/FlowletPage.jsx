/**
 * Surface #1 — the full Vendo page, reachable from the sidebar. The chat IS
 * the page: a tab strip with the live thread, one tab per saved flowlet
 * (persisted through the shell store, surviving reloads), and "+" for a fresh
 * chat. Compact adaptation of demo-bank's page surface.
 */
import React, { useEffect, useState } from "react";
import {
  FlowletThread,
  FlowletToast,
  useFlowletThread,
  useShell,
  useReopenFlowlet,
  originatingPrompt,
  stampHostComponents,
} from "@flowlet/shell";
import { prewiredComponents } from "@flowlet/components";
import { gmailHostComponents } from "./host-components";
import { FlowletRoot } from "./FlowletRoot";

const registry = [...prewiredComponents, ...gmailHostComponents];

const SUGGESTIONS = [
  "Turn my unread emails into Tinder: swipe left to delete, swipe right to reply for me. Swipe up to send it to my team's Slack with a quick summary.",
  "Summarize my unread emails",
  "Who emails me the most?",
];

const CHAT = "chat";

const NAME_MAX = 48;
const nameFrom = (prompt, fallback) => {
  const base = (prompt || "").trim() || fallback;
  return base.length <= NAME_MAX ? base : `${base.slice(0, NAME_MAX - 1).trimEnd()}…`;
};

/** Every rendered view in the thread becomes a saved flowlet (deduped by node
 *  id), named after the prompt that produced it — demo-bank's derivation. */
const deriveSavedDrafts = (items, knownIds) => {
  const drafts = [];
  for (const item of items) {
    if (item.kind !== "ui") continue;
    const { node } = item;
    if (knownIds.has(node.id) || drafts.some((d) => d.id === node.id)) continue;
    const prompt = originatingPrompt(items, item.key);
    drafts.push({
      id: node.id,
      name: nameFrom(prompt, "Saved view"),
      node,
      prompt,
      pinned: false,
      // Registry-version stamp (ENG-186): reopen diffs it to surface drift.
      components: stampHostComponents(node, registry),
    });
  }
  return drafts;
};

function PageSurface() {
  const chat = useFlowletThread();
  const { store } = useShell();
  const [active, setActive] = useState(CHAT);
  const [saved, setSaved] = useState([]);
  const [deleted, setDeleted] = useState([]);

  useEffect(() => {
    let cancelled = false;
    store.list().then((all) => {
      if (!cancelled) setSaved(all.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)));
    });
    return () => {
      cancelled = true;
    };
  }, [store]);

  useEffect(() => {
    const drafts = deriveSavedDrafts(chat.items, new Set(saved.map((s) => s.id)));
    if (drafts.length === 0) return;
    Promise.all(drafts.map((d) => store.save(d)))
      .then((records) => {
        setSaved((prev) => [...prev, ...records.filter((r) => !prev.some((p) => p.id === r.id))]);
      })
      .catch((error) => console.error("[flowlet] failed to persist saved view", error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.items]);

  const newChat = () => {
    chat.stop();
    chat.clearError();
    chat.setMessages([]);
    setActive(CHAT);
  };

  const persistPatch = (flow, patch) => {
    store
      .load(flow.id)
      .then((current) => {
        const { updatedAt: _prior, ...base } = current ?? flow;
        return store.save({ ...base, ...patch });
      })
      .then((record) => setSaved((prev) => prev.map((p) => (p.id === record.id ? record : p))))
      .catch((error) => console.error("[flowlet] failed to update saved view", error));
  };

  const deleteFlow = (flow) => {
    store
      .load(flow.id)
      .then(async (current) => {
        await store.remove(flow.id);
        setSaved((prev) => prev.filter((p) => p.id !== flow.id));
        setActive((now) => (now === flow.id ? CHAT : now));
        setDeleted((queue) => [...queue, current ?? flow]);
      })
      .catch((error) => console.error("[flowlet] failed to delete saved view", error));
  };

  const settleDelete = (flow, restore) => {
    setDeleted((queue) => queue.filter((f) => f.id !== flow.id));
    if (!restore) return;
    store
      .save(flow)
      .then((record) =>
        setSaved((prev) =>
          [...prev, record].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
        ),
      )
      .catch((error) => console.error("[flowlet] failed to restore saved view", error));
  };

  const activeSaved = saved.find((s) => s.id === active);

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
            greeting="What should Vendo build for you?"
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
          key={deleted[0].id}
          message={`Deleted "${deleted[0].name}"`}
          onAction={() => settleDelete(deleted[0], true)}
          onDismiss={() => settleDelete(deleted[0], false)}
        />
      )}
    </div>
  );
}

/** A reopened saved flowlet: snapshot first, then live re-run of its declared
 *  read-only queries through the governed action route. */
function SavedPane({ flowlet }) {
  const { renderNode } = useShell();
  const { node, status, errors, drift } = useReopenFlowlet(flowlet);
  const drifted = [...drift.missing, ...drift.changed];
  return (
    <div className="fl-saved-pane">
      {/* Registry drift (ENG-186): the app's components moved since the save. */}
      {drifted.length > 0 && (
        <div className="fl-drift-note">
          {drifted.join(", ")} {drifted.length === 1 ? "has" : "have"} changed since this view was
          saved — parts may render differently
        </div>
      )}
      {errors.length > 0 && status !== "live" && (
        <div className="fl-stale-note">showing saved data — live refresh unavailable</div>
      )}
      {renderNode(node)}
    </div>
  );
}

export default function FlowletPage() {
  // Bind the surface to the viewport below the fixed topbar + TopLine so the
  // message list scrolls internally and the composer stays pinned.
  return (
    <div
      style={{
        marginTop: 48,
        height: "calc(100dvh - 130px)",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
        background: "#fff",
      }}
    >
      <FlowletRoot>
        <PageSurface />
      </FlowletRoot>
    </div>
  );
}

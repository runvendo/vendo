/**
 * The designed card reference (card audit §10 — "no designed reference exists").
 *
 * Every card kind the chrome ships, rendered through the REAL components at
 * every state AND at the degraded-data cases that made cards diverge in use:
 * empty schema (the in-thread synthesized descriptor), nested args, more than
 * eight fields, connector slug names, a missing host ToolMeta, and a remote
 * logo that fails to load. Each case is wrapped in a `[data-gallery-case]`
 * figure so `scripts/capture-gallery.mjs cards` can emit one PNG per case.
 *
 * Fixtures use the components' CURRENT public props only — no private imports,
 * no test-only escape hatches — so this board keeps working (and keeps
 * documenting) as the card shell is restyled underneath it.
 */
import type { ApprovalRequest, Json, JsonSchema, Trigger } from "@vendoai/core";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { createVendoClient } from "../src/client.js";
import { VendoProvider } from "../src/context.js";
import {
  ApprovalCard,
  AutomationCard,
  ConnectCard,
  GrantSetCard,
  type GrantSetPermission,
} from "../src/chrome/index.js";
import type { ToolMetaMap } from "../src/chrome/humanize.js";

/** Host tool metadata, exactly as a host passes it to `VendoProvider tools`. */
export const GALLERY_TOOLS: ToolMetaMap = {
  host_transfer_funds: {
    label: "Transfer funds",
    description: "Move money between the customer's accounts.",
  },
  host_email_send: { label: "Send email" },
};

const CENTS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    amount: { type: "integer", description: "Amount in cents" },
    from: { type: "string" },
    to: { type: "string" },
  },
};

const noop = () => {};

function approval(over: {
  id: string;
  tool: string;
  args: Json;
  risk?: ApprovalRequest["descriptor"]["risk"];
  critical?: boolean;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  inputPreview?: string;
  invalidated?: boolean;
}): ApprovalRequest {
  return {
    id: over.id,
    call: { id: `call_${over.id}`, tool: over.tool, args: over.args },
    descriptor: {
      name: over.tool,
      description: over.description ?? "",
      inputSchema: over.inputSchema ?? {},
      risk: over.risk ?? "write",
      ...(over.critical === undefined ? {} : { critical: over.critical }),
      ...(over.title === undefined ? {} : { title: over.title }),
    },
    // The server preview: raw tool slug + canonical JSON, capped (guard.ts).
    inputPreview: over.inputPreview ?? `${over.tool} ${JSON.stringify(over.args)}`,
    ...(over.invalidated === true
      ? { invalidatedGrant: { id: "grn_1", grantedAt: "2026-05-04T10:00:00.000Z" } }
      : {}),
    ctx: {
      principal: { kind: "user", subject: "user_1" },
      venue: "chat",
      presence: "present",
    },
    createdAt: "2026-08-03T17:04:00.000Z",
  };
}

const PERMISSIONS: GrantSetPermission[] = [
  { approvalId: "apr_g1", tool: "host_invoices_list", risk: "read" },
  { approvalId: "apr_g2", tool: "slack_SLACK_SEND_MESSAGE", risk: "write" },
];

/** demo-bank's OWN catalog sentence for `host_getSpendingInsights`, as it read
 *  on 2026-08-03 — a line written for the MODEL that the grant row printed at a
 *  bank customer (spec §16 law 3, LEAK 1). The wire part carries a description
 *  and `thread/parts.tsx` casts it into these props, so the cast is the real
 *  path and the case renders through it. */
const MODEL_INSTRUCTION_PERMISSIONS = ([
  {
    approvalId: "apr_m1",
    tool: "host_getSpendingInsights",
    description: "Spending by category for the current period. Amounts are integer cents"
      + " (e.g. 285000 = $2,850.00): divide by 100 exactly once before displaying,"
      + " including any totals you compute.",
    risk: "read",
  },
  {
    approvalId: "apr_m2",
    tool: "host_transferMoney",
    description: "Send money to a person from the user's checking account. This IRREVERSIBLY"
      + " MOVES MONEY: it debits checking and appends a transfer. There is no undo.",
    risk: "destructive",
  },
] as unknown) as GrantSetPermission[];

/** The keyless (default OSS) connect refusal, exactly as the wire throws it —
 *  a TypeScript call and an environment variable (LEAK 2). The card must answer
 *  it in the consumer's voice, so this case CLICKS Connect on mount: the failed
 *  state in the PNG is the real error path, not a prop. */
function RefusedConnect() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    host.current?.querySelector("button")?.click();
  }, []);
  const client = useMemo(() => {
    const base = createVendoClient({ baseUrl: "http://127.0.0.1:9" });
    return {
      ...base,
      connections: {
        ...base.connections,
        initiate: async () => {
          throw Object.assign(
            new Error("connected accounts are not configured: pass a Composio connector"
              + " (composioConnector) to createVendo({ connectors }) or set VENDO_API_KEY"
              + " for the Vendo Cloud broker"),
            { code: "not-implemented" },
          );
        },
      },
    } as typeof base;
  }, []);
  return (
    <div ref={host}>
      <VendoProvider client={client} tools={GALLERY_TOOLS}>
        <ConnectCard
          connector="composio"
          toolkit="slack"
          message="Connect Slack so the summary can post to #finance."
          onConnected={noop}
        />
      </VendoProvider>
    </div>
  );
}

const SCHEDULE: Trigger = {
  on: { kind: "schedule", cron: "0 9 * * 1" },
  run: { kind: "agentic", prompt: "Summarize last week's spending and post it." },
};

export interface CardCase {
  id: string;
  label: string;
  /** Why this case exists — the caption under the PNG. */
  note: string;
  /** Ancestors may SIZE a card, never undress it (spec §16 law 1). */
  width?: number;
  node: ReactNode;
}

/** Cases whose card carries a remote toolkit logo — the capture script recaptures
    these with the logo CDN blocked to prove the `onError` fallback glyph. */
export const LOGO_CASES = [
  "approval-consequence",
  "grantset-parked",
  "connect-slack",
];

export const CARD_CASES: CardCase[] = [
  // ---- ApprovalCard: the reference, then every degradation --------------
  {
    id: "approval-pending",
    label: "Approval — pending (healthy data)",
    note: "host ToolMeta + declared cents schema: 4750 reads as $47.50",
    node: (
      <ApprovalCard
        approval={approval({
          id: "apr_1",
          tool: "host_transfer_funds",
          args: { amount: 4750, from: "Checking", to: "Savings" },
          inputSchema: CENTS_SCHEMA,
        })}
        onDecide={noop}
      />
    ),
  },
  {
    id: "approval-ceremony",
    label: "Approval — ceremony (destructive)",
    note: "risk=destructive: every input stays in plain sight, ceremony button",
    node: (
      <ApprovalCard
        approval={approval({
          id: "apr_2",
          tool: "host_invoice_delete",
          args: { invoice: "INV-2041", permanent: true },
          risk: "destructive",
        })}
        onDecide={noop}
      />
    ),
  },
  {
    id: "approval-consequence",
    label: "Approval — consequence sentence",
    note: "Slack inputs support a truthful sentence; the fields fold behind Details",
    node: (
      <ApprovalCard
        approval={approval({
          id: "apr_3",
          tool: "slack_SLACK_SEND_MESSAGE",
          args: { channel: "#finance", message: "July closed 12% under plan." },
        })}
        onDecide={noop}
      />
    ),
  },
  {
    id: "approval-empty-schema",
    label: "Approval — DEGRADED: empty schema",
    note: "the in-thread synthesized descriptor (inputSchema {}, description \"\"): money cannot format",
    node: (
      <ApprovalCard
        approval={approval({
          id: "apr_4",
          tool: "host_transfer_funds",
          args: { amount: 4750, from: "Checking", to: "Savings" },
        })}
        allowRemember={false}
        showContext={false}
        onDecide={noop}
      />
    ),
  },
  {
    id: "approval-nested-args",
    label: "Approval — DEGRADED: nested args",
    note: "a non-primitive value drops the whole card to the raw server preview",
    node: (
      <ApprovalCard
        approval={approval({
          id: "apr_5",
          tool: "host_email_send",
          args: { to: "dana@maple.test", body: { subject: "Receipts", lines: ["one", "two"] } },
        })}
        onDecide={noop}
      />
    ),
  },
  {
    id: "approval-nested-money",
    label: "Approval — money INSIDE a nested object",
    note: "Maple's live host_createOrder shape: a declared-cents amount one level down reads as money, not as 1850 (LEAK 3)",
    node: (
      <ApprovalCard
        approval={approval({
          id: "apr_nested_money",
          tool: "host_createOrder",
          title: "Place an order",
          args: { merchant: "DoorDash", charge: { amount_cents: 1850, descriptor: "DOORDASH SF" }, undeclared: { amount: 1850 } },
          inputSchema: {
            type: "object",
            properties: {
              merchant: { type: "string" },
              charge: {
                type: "object",
                properties: {
                  amount_cents: { type: "integer", description: "Charge amount in integer cents" },
                  descriptor: { type: "string" },
                },
              },
            },
          },
        })}
        onDecide={noop}
      />
    ),
  },
  {
    id: "approval-many-fields",
    label: "Approval — DEGRADED: more than eight fields",
    note: "nine primitive args exceed the field-row cap and fall to the raw preview",
    node: (
      <ApprovalCard
        approval={approval({
          id: "apr_6",
          tool: "host_report_build",
          args: {
            from: "2026-07-01", to: "2026-07-31", currency: "USD", grouping: "category",
            includeRefunds: true, includeTransfers: false, minimum: 0, format: "pdf",
            recipient: "dana@maple.test",
          },
        })}
        onDecide={noop}
      />
    ),
  },
  {
    id: "approval-slug-name",
    label: "Approval — DEGRADED: connector slug name",
    note: "no host ToolMeta: the raw connector slug must never reach the surface",
    node: (
      <ApprovalCard
        approval={approval({
          id: "apr_7",
          tool: "gmail_GMAIL_CREATE_EMAIL_DRAFT",
          args: { to: "dana@maple.test", subject: "July receipts" },
        })}
        onDecide={noop}
      />
    ),
  },
  {
    id: "approval-no-toolmeta",
    label: "Approval — DEGRADED: missing ToolMeta",
    note: "no label, no description, no schema — the prettified id carries the card",
    node: (
      <ApprovalCard
        approval={approval({ id: "apr_8", tool: "host_ledger_reconcile", args: { period: "2026-07" } })}
        onDecide={noop}
      />
    ),
  },
  {
    id: "approval-invalidated",
    label: "Approval — previous permission invalidated",
    note: "the tool changed since the grant: contained notice above the actions",
    node: (
      <ApprovalCard
        approval={approval({
          id: "apr_9",
          tool: "host_transfer_funds",
          args: { amount: 4750, from: "Checking", to: "Savings" },
          inputSchema: CENTS_SCHEMA,
          invalidated: true,
        })}
        onDecide={noop}
      />
    ),
  },
  {
    id: "approval-queue-width",
    label: "Approval — queue width (sized, not undressed)",
    note: "an ancestor may only set width on the shell (spec §16 law 1)",
    width: 380,
    node: (
      <ApprovalCard
        approval={approval({
          id: "apr_10",
          tool: "host_transfer_funds",
          args: { amount: 4750, from: "Checking", to: "Savings" },
          inputSchema: CENTS_SCHEMA,
        })}
        onDecide={noop}
      />
    ),
  },

  // ---- GrantSetCard: parked → settled ----------------------------------
  {
    id: "grantset-parked",
    label: "Standing access — parked",
    note: "one Approve grants the whole set; each read and write enumerated",
    node: <GrantSetCard name="Friday spending summary" permissions={PERMISSIONS} state="parked" onDecide={noop} />,
  },
  {
    id: "grantset-approved",
    label: "Standing access — settled (approved)",
    note: "the decided card stays in the transcript as the record",
    node: <GrantSetCard name="Friday spending summary" permissions={PERMISSIONS} state="approved" />,
  },
  {
    id: "grantset-denied",
    label: "Standing access — settled (declined)",
    note: "denied: the automation stays paused",
    node: <GrantSetCard name="Friday spending summary" permissions={PERMISSIONS} state="denied" />,
  },
  {
    id: "grantset-model-instruction",
    label: "Standing access — HOSTILE: the catalog's model-facing sentences",
    note: "demo-bank's own descriptions (integer cents, divide by 100, IRREVERSIBLY MOVES MONEY) reach the card and never the screen (LEAK 1)",
    node: <GrantSetCard name="Spending watcher" permissions={MODEL_INSTRUCTION_PERMISSIONS} state="parked" onDecide={noop} />,
  },
  {
    id: "grantset-slug-tools",
    label: "Standing access — DEGRADED: slug tools, no ToolMeta",
    note: "raw connector slugs in every row; titles must still read as words",
    node: (
      <GrantSetCard
        name="Inbox triage"
        state="parked"
        onDecide={noop}
        permissions={[
          { approvalId: "apr_s1", tool: "gmail_GMAIL_FETCH_EMAILS", risk: "read" },
          { approvalId: "apr_s2", tool: "gmail_GMAIL_CREATE_EMAIL_DRAFT", risk: "write" },
          { approvalId: "apr_s3", tool: "notion_NOTION_ADD_PAGE_CONTENT", risk: "write" },
        ]}
      />
    ),
  },

  // ---- AutomationCard --------------------------------------------------
  {
    id: "automation-enabled",
    label: "Automation — enabled",
    note: "schedule → action flow, live dot",
    node: <AutomationCard name="Friday spending summary" enabled trigger={SCHEDULE} description="Posts last week's spending to #finance." />,
  },
  {
    id: "automation-paused",
    label: "Automation — paused",
    note: "disabled: no live dot, the flow stays readable",
    node: <AutomationCard name="Friday spending summary" enabled={false} trigger={SCHEDULE} />,
  },
  {
    id: "automation-waiting-grants",
    label: "Automation — waiting on permissions",
    note: "enabled but the grant set is undecided",
    node: <AutomationCard name="Invoice watcher" enabled trigger={SCHEDULE} pendingGrants={2} />,
  },
  {
    id: "automation-sponsored",
    label: "Automation — sponsored, shared",
    note: "it always runs as a named person; the wider editor set when knowable",
    node: <AutomationCard name="Invoice watcher" enabled trigger={SCHEDULE} sponsor={{ subject: "user_9", display: "Dana" }} editors={3} />,
  },
  {
    id: "automation-no-trigger",
    label: "Automation — DEGRADED: no trigger",
    note: "identity only, no flow nodes to draw",
    node: <AutomationCard name="Ad-hoc reconcile" enabled={false} />,
  },

  // ---- ConnectCard -----------------------------------------------------
  {
    id: "connect-slack",
    label: "Connect — known toolkit",
    note: "proper-case toolkit name and its real mark, never the raw slug",
    node: <ConnectCard connector="slack" toolkit="slack" message="Connect Slack so the summary can post to #finance." onConnected={noop} />,
  },
  {
    id: "connect-refused",
    label: "Connect — REFUSED on a keyless deployment",
    note: "the wire's sentence names createVendo({ connectors }) and VENDO_API_KEY; the card says what it means for the person (LEAK 2)",
    node: <RefusedConnect />,
  },
  {
    id: "connect-slug-toolkit",
    label: "Connect — DEGRADED: unknown slug toolkit",
    note: "an unlisted toolkit slug still reads as words",
    node: <ConnectCard connector="acme_crm" toolkit="acme_crm" message="Connect Acme Crm to read the pipeline." onConnected={noop} />,
  },
];

export function CardsBoard() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      {CARD_CASES.map(item => (
        <figure
          key={item.id}
          data-gallery-case={item.id}
          // The capture script recaptures the marked cases with the logo CDN
          // blocked — the forced-failure pass, read off the DOM so the list
          // lives in exactly one place.
          {...(LOGO_CASES.includes(item.id) ? { "data-gallery-logo": "" } : {})}
          style={{ margin: 0, display: "flex", flexDirection: "column", gap: 8 }}
        >
          <figcaption style={{ fontSize: 12, lineHeight: 1.5 }}>
            <b>{item.label}</b>
            <span style={{ opacity: 0.62 }}> — {item.note}</span>
          </figcaption>
          <div style={item.width === undefined ? undefined : { width: item.width }}>{item.node}</div>
        </figure>
      ))}
    </div>
  );
}

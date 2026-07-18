/**
 * Playground fixtures — every scenario renders the REAL chrome against these:
 * director-mode scripts (the `DirectorScript` format the demo-host fixtures
 * already use, see packages/ui/src/hooks/scripted-transport.ts) for streamed
 * turns, and static wire payloads served by the in-page fake client for
 * everything the collection hooks fetch. No model key, no network.
 */
import type {
  AppDocument,
  ApprovalRequest,
  AuditEvent,
  PermissionGrant,
  Principal,
  UIPayload,
} from "@vendoai/core";
import type {
  AutomationEntry,
  ConnectionAccount,
  DirectorScript,
  RunRecord,
  Thread,
  ThreadSummary,
  ToolMetaMap,
  VendoStatus,
} from "@vendoai/ui";
import type { UIMessageChunk } from "ai";

const PRINCIPAL: Principal = { kind: "user", subject: "user_playground", display: "Avery Quinn" };

/** Friendly labels so build beats speak like a host would make them speak. */
export const playgroundToolMeta: ToolMetaMap = {
  host_listRenewals: { label: "Reading upcoming renewals" },
  host_listAccounts: { label: "Reading your accounts" },
  vendo_apps_create: { label: "Building your view" },
  slack_SLACK_SEND_MESSAGE: { label: "Post to #renewals in Slack" },
};

/* ------------------------------------------------------------------ */
/* Generated views (vendo-genui/v1)                                    */
/* ------------------------------------------------------------------ */

const HERO_SOURCE = `
import * as React from "react";
const S = { ink: "#14151a", soft: "#4c4d55", faint: "#8a8b92", line: "#e8e6e1", green: "#1e7f53", greenBg: "#e7f4ee" };
export default function RenewalHero() {
  const tile = (label, value, sub) => (
    <div style={{ flex: 1, border: "1px solid " + S.line, borderRadius: 10, padding: "10px 12px", background: "#fff" }}>
      <div style={{ fontSize: 11.5, color: S.soft }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 650, color: S.ink, letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ fontSize: 10.5, color: S.faint }}>{sub}</div>
    </div>
  );
  return (
    <div style={{ fontFamily: "Inter, system-ui", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, color: "#15573a", background: S.greenBg, borderRadius: 999, padding: "3px 10px" }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: S.green }} />
          next 30 days
        </span>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        {tile("Renewals due", 7, "of 42 active accounts")}
        {tile("At risk", 2, "no touchpoint in 60 days")}
        {tile("Next up", "3d", "Northwind \\u00b7 Jul 21")}
      </div>
    </div>
  );
}
`;

const LIST_SOURCE = `
import * as React from "react";
const S = { ink: "#14151a", soft: "#4c4d55", faint: "#8a8b92", line: "#e8e6e1", red: "#b0473a", redBg: "#fbede9", amber: "#a16207", amberBg: "#faf3e3", green: "#15573a", greenBg: "#e7f4ee" };
const ROWS = [
  { name: "Northwind Traders", plan: "Scale \\u00b7 $18k", due: "Jul 21", state: "at risk" },
  { name: "Fabrikam", plan: "Growth \\u00b7 $9k", due: "Jul 24", state: "on track" },
  { name: "Contoso Ltd", plan: "Scale \\u00b7 $22k", due: "Jul 29", state: "at risk" },
  { name: "Adventure Works", plan: "Starter \\u00b7 $3k", due: "Aug 02", state: "on track" },
];
export default function RenewalList() {
  const badge = (state) => state === "at risk"
    ? { color: S.red, background: S.redBg }
    : { color: S.green, background: S.greenBg };
  return (
    <div style={{ fontFamily: "Inter, system-ui", border: "1px solid " + S.line, borderRadius: 10, background: "#fff" }}>
      {ROWS.map((row, index) => (
        <div key={row.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderTop: index ? "1px solid " + S.line : "none" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: S.ink }}>{row.name}</div>
            <div style={{ fontSize: 11, color: S.faint }}>{row.plan}</div>
          </div>
          <div style={{ fontSize: 11.5, color: S.soft }}>{row.due}</div>
          <span style={{ fontSize: 10.5, fontWeight: 600, borderRadius: 999, padding: "3px 9px", ...badge(row.state) }}>{row.state}</span>
        </div>
      ))}
    </div>
  );
}
`;

/** The finished "Renewals radar" view — also the slot's pinned payload. */
export function renewalsViewPayload(): UIPayload {
  return {
    formatVersion: "vendo-genui/v1",
    name: "Renewals radar",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", props: { gap: 14 }, children: ["hero", "list"] },
      { id: "hero", component: "RenewalHero", source: "generated" },
      { id: "list", component: "RenewalList", source: "generated" },
    ],
    components: { RenewalHero: HERO_SOURCE, RenewalList: LIST_SOURCE },
  };
}

/** A deliberately broken payload. The renderer is fail-soft about CONTENT
 *  problems (bad root, missing components → contained notices), so to reach
 *  the slot's recovery path this has to crash the renderer itself: a partial
 *  (`streaming: true`) payload whose `nodes` is malformed throws host-side in
 *  TreeView, outside the per-node boundaries — and VendoSlot's PinMount
 *  boundary keeps the host's original children visible (06-apps §8). */
export function brokenViewPayload(): UIPayload {
  return {
    formatVersion: "vendo-genui/v1",
    name: "Broken view",
    root: "root",
    streaming: true,
    nodes: "corrupted-in-transit",
  };
}

function streamingViewChunk(nodeIds: string[], streaming: boolean): UIMessageChunk {
  const payload = renewalsViewPayload() as UIPayload & { nodes: Array<{ id: string }>; streaming?: boolean };
  payload.nodes = payload.nodes.filter((node) => node.id === "root" || nodeIds.includes(node.id));
  (payload.nodes.find((node) => node.id === "root") as { children?: string[] }).children = nodeIds;
  if (streaming) payload.streaming = true;
  return {
    type: "data-vendo-view",
    id: "vendo-view:app_renewals",
    data: { appId: "app_renewals", payload },
  } as UIMessageChunk;
}

/* ------------------------------------------------------------------ */
/* Director scripts                                                    */
/* ------------------------------------------------------------------ */

const chunk = (delay: number, value: unknown): { delay: number; chunk: UIMessageChunk } => ({
  delay,
  chunk: value as UIMessageChunk,
});

const STREAMED_ANSWER: string[] = [
  "Here's where your renewals stand. ",
  "Seven accounts come up for renewal in the next thirty days, ",
  "with a combined contract value of about $61k. ",
  "Two of them — Northwind Traders and Contoso — look at risk: ",
  "no touchpoint in over sixty days and declining seat usage. ",
  "Fabrikam and Adventure Works are healthy; both expanded last quarter. ",
  "If you'd like, I can build you a small view that tracks all of this live, ",
  "sorted by renewal date with the at-risk accounts pinned on top. ",
  "I can also draft the outreach for the two at-risk accounts ",
  "and post a heads-up to your team in Slack every morning at 8:00 ",
  "so nothing slips through. ",
  "Just say the word and I'll wire it up.",
];

/** A long, slowly streaming text turn — the "streaming" screenshot state. */
export function streamingScript(): DirectorScript {
  return {
    turns: [
      {
        cues: [
          chunk(0, { type: "start" }),
          chunk(100, { type: "start-step" }),
          chunk(400, { type: "tool-input-start", toolCallId: "call_renewals", toolName: "host_listRenewals" }),
          chunk(300, { type: "tool-input-available", toolCallId: "call_renewals", toolName: "host_listRenewals", input: {} }),
          chunk(900, { type: "tool-output-available", toolCallId: "call_renewals", output: { ok: true, count: 7 } }),
          chunk(500, { type: "text-start", id: "txt_stream" }),
          ...STREAMED_ANSWER.map((delta) => chunk(950, { type: "text-delta", id: "txt_stream", delta })),
          chunk(300, { type: "text-end", id: "txt_stream" }),
          chunk(100, { type: "finish-step" }),
          chunk(50, { type: "finish" }),
        ],
      },
    ],
  };
}

/** Tool beats → a generated view streaming in → a closing summary. */
export function viewScript(): DirectorScript {
  return {
    turns: [
      {
        cues: [
          chunk(0, { type: "start" }),
          chunk(100, { type: "start-step" }),
          chunk(400, { type: "tool-input-start", toolCallId: "call_renewals", toolName: "host_listRenewals" }),
          chunk(300, { type: "tool-input-available", toolCallId: "call_renewals", toolName: "host_listRenewals", input: {} }),
          chunk(1000, { type: "tool-output-available", toolCallId: "call_renewals", output: { ok: true, count: 7 } }),
          chunk(400, { type: "tool-input-start", toolCallId: "call_build", toolName: "vendo_apps_create" }),
          chunk(300, { type: "tool-input-available", toolCallId: "call_build", toolName: "vendo_apps_create", input: { prompt: "renewals radar" } }),
          chunk(700, streamingViewChunk(["hero"], true)),
          chunk(1600, streamingViewChunk(["hero", "list"], true)),
          chunk(1800, streamingViewChunk(["hero", "list"], false)),
          chunk(700, { type: "tool-output-available", toolCallId: "call_build", output: { appId: "app_renewals" } }),
          chunk(500, { type: "text-start", id: "txt_view" }),
          chunk(150, { type: "text-delta", id: "txt_view", delta: "Your Renewals radar is live — " }),
          chunk(170, { type: "text-delta", id: "txt_view", delta: "at-risk accounts stay pinned on top, " }),
          chunk(170, { type: "text-delta", id: "txt_view", delta: "and it refreshes from your account data as things change." }),
          chunk(120, { type: "text-end", id: "txt_view" }),
          chunk(100, { type: "finish-step" }),
          chunk(50, { type: "finish" }),
        ],
      },
    ],
  };
}

/** Turn 0 parks on a write approval; deciding it resumes turn 1 (03-agent §4). */
export function approvalScript(): DirectorScript {
  return {
    turns: [
      {
        cues: [
          chunk(0, { type: "start" }),
          chunk(100, { type: "start-step" }),
          chunk(400, { type: "tool-input-start", toolCallId: "call_renewals", toolName: "host_listRenewals" }),
          chunk(300, { type: "tool-input-available", toolCallId: "call_renewals", toolName: "host_listRenewals", input: {} }),
          chunk(900, { type: "tool-output-available", toolCallId: "call_renewals", output: { ok: true, atRisk: 2 } }),
          chunk(500, { type: "tool-input-start", toolCallId: "call_slack", toolName: "slack_SLACK_SEND_MESSAGE" }),
          chunk(300, {
            type: "tool-input-available",
            toolCallId: "call_slack",
            toolName: "slack_SLACK_SEND_MESSAGE",
            input: { channel: "#renewals", message: "Heads up: Northwind and Contoso renew this month with no recent touchpoint." },
          }),
          chunk(300, { type: "data-vendo-approval", id: "risk:call_slack", data: { toolCallId: "call_slack", risk: "write" } }),
          chunk(600, { type: "tool-approval-request", approvalId: "appr_slack", toolCallId: "call_slack" }),
          chunk(200, { type: "finish-step" }),
          chunk(50, { type: "finish" }),
        ],
      },
      {
        cues: [
          chunk(0, { type: "start" }),
          chunk(100, { type: "start-step" }),
          chunk(800, { type: "tool-output-available", toolCallId: "call_slack", output: { ok: true, channel: "#renewals" } }),
          chunk(400, { type: "text-start", id: "txt_resumed" }),
          chunk(150, { type: "text-delta", id: "txt_resumed", delta: "Posted to #renewals — " }),
          chunk(170, { type: "text-delta", id: "txt_resumed", delta: "your team knows about both at-risk renewals, " }),
          chunk(170, { type: "text-delta", id: "txt_resumed", delta: "and I'll flag any account that goes quiet from here on." }),
          chunk(120, { type: "text-end", id: "txt_resumed" }),
          chunk(100, { type: "finish-step" }),
          chunk(50, { type: "finish" }),
        ],
      },
    ],
  };
}

/** A connector call that needs a per-user connected account first (04 §3). */
export function connectScript(): DirectorScript {
  return {
    turns: [
      {
        cues: [
          chunk(0, { type: "start" }),
          chunk(100, { type: "start-step" }),
          chunk(500, { type: "tool-input-start", toolCallId: "call_slack", toolName: "slack_SLACK_SEND_MESSAGE" }),
          chunk(300, {
            type: "tool-input-available",
            toolCallId: "call_slack",
            toolName: "slack_SLACK_SEND_MESSAGE",
            input: { channel: "#renewals", message: "Renewals digest for the week" },
          }),
          chunk(800, {
            type: "tool-output-available",
            toolCallId: "call_slack",
            output: {
              status: "connect-required",
              connect: { connector: "slack", toolkit: "slack", message: "Connect Slack to post the digest to #renewals." },
            },
          }),
          chunk(400, { type: "text-start", id: "txt_connect" }),
          chunk(150, { type: "text-delta", id: "txt_connect", delta: "I drafted the digest — " }),
          chunk(170, { type: "text-delta", id: "txt_connect", delta: "connect your Slack and I'll post it to #renewals." }),
          chunk(120, { type: "text-end", id: "txt_connect" }),
          chunk(100, { type: "finish-step" }),
          chunk(50, { type: "finish" }),
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Static wire payloads                                                */
/* ------------------------------------------------------------------ */

export interface PlaygroundFixtures {
  status: VendoStatus;
  threads: Array<ThreadSummary & { thread: Thread }>;
  apps: AppDocument[];
  automations: AutomationEntry[];
  connections: ConnectionAccount[];
  approvals: ApprovalRequest[];
  grants: PermissionGrant[];
  activity: AuditEvent[];
  runs: RunRecord[];
}

function textTurn(id: string, role: "user" | "assistant", text: string): Thread["messages"][number] {
  return { id, role, parts: [{ type: "text", text }] };
}

/** Fresh copies every call: scenario state never leaks between mounts. */
export function playgroundFixtures(): PlaygroundFixtures {
  const renewalsApp: AppDocument = {
    format: "vendo/app@1",
    id: "app_renewals",
    name: "Renewals radar",
    description: "Upcoming renewals sorted by date, at-risk accounts pinned on top.",
    ui: "tree",
    tree: renewalsViewPayload(),
  };
  const digestApp: AppDocument = {
    format: "vendo/app@1",
    id: "app_digest",
    name: "Morning renewals digest",
    description: "Posts the renewals digest to #renewals every morning at 8:00.",
    trigger: { on: { kind: "schedule", every: "1d" }, run: { kind: "agentic", prompt: "Summarize renewal changes and post to #renewals." } },
  };

  return {
    status: { posture: "rules", version: "0.3.0-playground", blocks: { agent: {}, guard: {}, apps: {} } },
    threads: [
      {
        id: "thr_renewals",
        title: "Renewals radar",
        updatedAt: "2026-07-18T09:12:00.000Z",
        thread: {
          id: "thr_renewals",
          subject: "Renewals radar",
          createdAt: "2026-07-18T09:02:00.000Z",
          updatedAt: "2026-07-18T09:12:00.000Z",
          messages: [
            textTurn("msg_r1", "user", "Which accounts renew this month, and which of them are at risk?"),
            textTurn(
              "msg_r2",
              "assistant",
              "Seven accounts renew in the next thirty days. Two look at risk — Northwind Traders and Contoso — no touchpoint in over sixty days.",
            ),
            textTurn("msg_r3", "user", "Build me a view that tracks this live."),
            {
              id: "msg_r4",
              role: "assistant",
              parts: [
                {
                  type: "data-vendo-view",
                  id: "vendo-view:app_renewals",
                  data: { appId: "app_renewals", payload: renewalsViewPayload() },
                } as Thread["messages"][number]["parts"][number],
                { type: "text", text: "Your Renewals radar is live — at-risk accounts stay pinned on top." },
              ],
            },
          ],
        },
      },
      {
        id: "thr_onboarding",
        title: "Onboarding checklist",
        updatedAt: "2026-07-17T15:40:00.000Z",
        thread: {
          id: "thr_onboarding",
          subject: "Onboarding checklist",
          createdAt: "2026-07-17T15:31:00.000Z",
          updatedAt: "2026-07-17T15:40:00.000Z",
          messages: [
            textTurn("msg_o1", "user", "What's left before the Fabrikam workspace goes live?"),
            textTurn("msg_o2", "assistant", "Two steps: their SSO domain is unverified, and the billing contact hasn't accepted the invite. Both owners were nudged yesterday."),
          ],
        },
      },
      {
        id: "thr_billing",
        title: "Billing question",
        updatedAt: "2026-07-16T11:05:00.000Z",
        thread: {
          id: "thr_billing",
          subject: "Billing question",
          createdAt: "2026-07-16T11:00:00.000Z",
          updatedAt: "2026-07-16T11:05:00.000Z",
          messages: [
            textTurn("msg_b1", "user", "Why did the Contoso invoice change this cycle?"),
            textTurn("msg_b2", "assistant", "They added 14 seats on July 3rd — the delta is prorated on this invoice and rolls into the base from next cycle."),
          ],
        },
      },
    ],
    apps: [renewalsApp, digestApp],
    automations: [{ app: digestApp, enabled: true }],
    connections: [
      { id: "conn_slack", connector: "composio", toolkit: "slack", status: "active", createdAt: "2026-06-30T08:00:00.000Z" },
      { id: "conn_github", connector: "composio", toolkit: "github", status: "expired", createdAt: "2026-05-12T10:00:00.000Z" },
    ],
    approvals: [
      {
        id: "appr_digest_slack",
        call: {
          id: "call_digest_slack",
          tool: "slack_SLACK_SEND_MESSAGE",
          args: { channel: "#renewals", message: "Morning digest: 7 renewals in the next 30 days, 2 at risk." },
        },
        descriptor: {
          name: "slack_SLACK_SEND_MESSAGE",
          description: "Post a message to a Slack channel.",
          inputSchema: { type: "object" },
          risk: "write",
        },
        inputPreview: "channel: #renewals\nmessage: Morning digest: 7 renewals in the next 30 days, 2 at risk.",
        ctx: { principal: PRINCIPAL, venue: "automation", presence: "away", appId: "app_digest", trigger: { runId: "run_02", kind: "schedule" } },
        createdAt: "2026-07-18T08:00:00.000Z",
      },
    ],
    grants: [
      {
        id: "grant_renewals_read",
        subject: PRINCIPAL.subject,
        tool: "host_listRenewals",
        descriptorHash: "sha256:playground",
        scope: { kind: "tool" },
        duration: "standing",
        source: "chat",
        grantedAt: "2026-07-01T09:00:00.000Z",
      },
    ],
    activity: [
      {
        id: "aud_01",
        at: "2026-07-18T08:00:05.000Z",
        kind: "run",
        principal: PRINCIPAL,
        venue: "automation",
        presence: "away",
        appId: "app_digest",
        tool: "host_listRenewals",
        inputPreview: "{}",
        outcome: "ok",
        decidedBy: "grant",
      },
      {
        id: "aud_02",
        at: "2026-07-18T08:00:09.000Z",
        kind: "approval",
        principal: PRINCIPAL,
        venue: "automation",
        presence: "away",
        appId: "app_digest",
        tool: "slack_SLACK_SEND_MESSAGE",
        inputPreview: "channel: #renewals",
        outcome: "pending-approval",
        decidedBy: "rule",
      },
      {
        id: "aud_03",
        at: "2026-07-18T09:04:00.000Z",
        kind: "tool-call",
        principal: PRINCIPAL,
        venue: "chat",
        presence: "present",
        tool: "host_listRenewals",
        inputPreview: "{}",
        outcome: "ok",
        decidedBy: "grant",
      },
      {
        id: "aud_04",
        at: "2026-07-18T09:05:30.000Z",
        kind: "app-lifecycle",
        principal: PRINCIPAL,
        venue: "chat",
        presence: "present",
        appId: "app_renewals",
        inputPreview: "created “Renewals radar”",
        outcome: "ok",
      },
      {
        id: "aud_05",
        at: "2026-07-18T09:06:10.000Z",
        kind: "tool-call",
        principal: PRINCIPAL,
        venue: "chat",
        presence: "present",
        tool: "host_deleteAccount",
        inputPreview: "account: Contoso Ltd",
        outcome: "blocked",
        decidedBy: "rule",
      },
    ],
    runs: [
      {
        id: "run_01",
        appId: "app_digest",
        trigger: { kind: "schedule" },
        status: "ok",
        startedAt: "2026-07-17T08:00:00.000Z",
        finishedAt: "2026-07-17T08:00:21.000Z",
        steps: [
          { id: "step_1", tool: "host_listRenewals", outcome: "ok", at: "2026-07-17T08:00:04.000Z" },
          { id: "step_2", tool: "slack_SLACK_SEND_MESSAGE", outcome: "ok", at: "2026-07-17T08:00:19.000Z" },
        ],
        summary: "Digest posted to #renewals.",
      },
      {
        id: "run_02",
        appId: "app_digest",
        trigger: { kind: "schedule" },
        status: "pending-approval",
        startedAt: "2026-07-18T08:00:00.000Z",
        steps: [
          { id: "step_1", tool: "host_listRenewals", outcome: "ok", at: "2026-07-18T08:00:04.000Z" },
          { id: "step_2", tool: "slack_SLACK_SEND_MESSAGE", outcome: "pending-approval", at: "2026-07-18T08:00:09.000Z" },
        ],
        summary: "Waiting on the Slack post approval.",
      },
    ],
  };
}

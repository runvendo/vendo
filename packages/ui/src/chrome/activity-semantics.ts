/** ENG-224 — activity panel semantics.

    Pure, render-site helpers that turn a raw `AuditEvent` (01-core §7) into the
    concrete, human-readable pieces the Activity panel shows: what happened, how
    it resolved and when. Kept out of the component so every mapping is unit
    tested in isolation and stays deterministic (see `formatAuditTime`). */
import type { AuditEvent } from "@vendoai/core";
import { toolTitle, type ToolMetaMap } from "./humanize.js";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Format an ISO instant as a human absolute timestamp — e.g.
    `2026-07-11T12:00:00.000Z` → "Jul 11, 2026, 12:00 PM".

    Rendered in UTC and assembled by hand rather than via `Intl`/relative time so
    the exact string is identical on a developer laptop and in CI regardless of
    the machine's timezone, locale or ICU data (no flaky screenshots or asserts).
    Anything that is not a parseable instant is returned unchanged. */
export function formatAuditTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const month = MONTHS[date.getUTCMonth()];
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  const rawHours = date.getUTCHours();
  const meridiem = rawHours < 12 ? "AM" : "PM";
  const hours = rawHours % 12 === 0 ? 12 : rawHours % 12;
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${month} ${day}, ${year}, ${hours}:${minutes} ${meridiem}`;
}

/** The tone the outcome pill/icon renders with (drives colour + glyph). */
export type OutcomeTone = "ok" | "error" | "pending" | "running" | "blocked" | "connect";

const OUTCOMES: Record<NonNullable<AuditEvent["outcome"]>, { label: string; tone: OutcomeTone }> = {
  ok: { label: "Succeeded", tone: "ok" },
  error: { label: "Failed", tone: "error" },
  "pending-approval": { label: "Awaiting approval", tone: "pending" },
  blocked: { label: "Blocked", tone: "blocked" },
  "connect-required": { label: "Connect required", tone: "connect" },
};

/** Map a wire outcome to a human label + tone. A missing outcome means the
    action is still in flight, not that it failed. */
export function outcomeLabel(outcome: AuditEvent["outcome"]): { label: string; tone: OutcomeTone } {
  if (outcome === undefined) return { label: "Running", tone: "running" };
  return OUTCOMES[outcome] ?? { label: outcome, tone: "running" };
}

const KIND_LABEL: Record<AuditEvent["kind"], string> = {
  "tool-call": "Tool",
  approval: "Approval",
  "policy-decision": "Policy",
  run: "Automation",
  "app-lifecycle": "App",
  share: "Share",
  "door-auth": "Connection",
  principal: "Identity",
};

/** Turn an audit event into the two readable strings a row shows: a short kind
    badge and a concrete action phrase. Tool-bearing kinds name the humanized
    tool (host metadata wins, else the prettified slug — never a raw id); the
    remaining kinds each get a plain-language phrase so no row is a mystery. */
export function describeActivity(
  event: AuditEvent,
  tools?: ToolMetaMap,
): { kindLabel: string; action: string } {
  const kindLabel = KIND_LABEL[event.kind];
  const tool = event.tool ? toolTitle(event.tool, tools?.[event.tool]) : undefined;
  const action = actionPhrase(event.kind, tool);
  return { kindLabel, action };
}

function actionPhrase(kind: AuditEvent["kind"], tool: string | undefined): string {
  switch (kind) {
    case "tool-call":
      return tool ?? "Tool call";
    case "approval":
      return tool ? `Approval: ${tool}` : "Approval request";
    case "door-auth":
      return "Account connected";
    case "run":
      return "Automation run";
    case "policy-decision":
      return "Policy decision";
    case "app-lifecycle":
      return "App updated";
    case "share":
      return "App shared";
    case "principal":
      return "Identity updated";
  }
}

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

/** Format an ISO instant relative to `now` — "just now", "54m ago", "2h ago",
    "yesterday" — falling back to the absolute `formatAuditTime` string beyond
    48 hours (or for unparseable/future instants). `now` is an argument, never
    read from the clock here, so every mapping stays deterministic in tests. */
export function formatRelativeAuditTime(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < 0) return formatAuditTime(iso);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "yesterday";
  return formatAuditTime(iso);
}

/** The glyph disc an activity row leads with (ui-lane-panels pick B). */
export type ActivityGlyph = "wrench" | "zap" | "shield" | "box";

const KIND_GLYPH: Record<AuditEvent["kind"], ActivityGlyph> = {
  "tool-call": "wrench",
  run: "zap",
  approval: "shield",
  "policy-decision": "shield",
  "app-lifecycle": "box",
  share: "box",
  "door-auth": "wrench",
  principal: "wrench",
};

/** Map an audit kind to its ledger glyph; unknown kinds read as a tool. */
export function kindGlyph(kind: AuditEvent["kind"]): ActivityGlyph {
  return KIND_GLYPH[kind] ?? "wrench";
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

/** Event-aware outcome mapping. Approval-kind events record their resolution
    in `detail` (the guard's decide writes `{ approved }`, revoke writes
    `{ grantRevoked }`) with NO wire `outcome` — through the plain mapping
    above they would read "Running" forever. Everything else defers to
    {@link outcomeLabel}. */
export function eventOutcomeLabel(
  event: Pick<AuditEvent, "kind" | "outcome" | "detail">,
): { label: string; tone: OutcomeTone } {
  if (event.outcome === undefined && event.kind === "approval") {
    const detail = (event.detail ?? {}) as { approved?: unknown; grantRevoked?: unknown };
    if (detail.approved === true) return { label: "Approved", tone: "ok" };
    if (detail.approved === false) return { label: "Denied", tone: "blocked" };
    if (typeof detail.grantRevoked === "string") return { label: "Grant revoked", tone: "ok" };
    if (typeof (detail as { approvalRevoked?: unknown }).approvalRevoked === "string") {
      return { label: "Decision taken back", tone: "ok" };
    }
    // The no arrived while an earlier yes on the same call was already being
    // spent: it ran. Reads as an outcome, not as a row still in flight.
    if (typeof (detail as { supersedeTooLate?: unknown }).supersedeTooLate === "string") {
      return { label: "Ran before the no landed", tone: "error" };
    }
  }
  if (event.outcome === undefined && event.kind === "run") {
    const detail = (event.detail ?? {}) as { harness?: unknown; error?: unknown };
    // The harness runtime stamps `harness` and writes this row from `onFinish`,
    // so the row's EXISTENCE is its completion — showing it as in-flight (with a
    // pulsing icon) told users a finished turn was still running, and told them
    // a failed one was still running too. Automation-engine rows carry their own
    // `status` in `detail` instead; what those should read is a separate, older
    // question and this branch deliberately leaves them alone.
    if (typeof detail.harness === "string") {
      return detail.error === undefined
        ? { label: "Succeeded", tone: "ok" }
        : { label: "Failed", tone: "error" };
    }
  }
  return outcomeLabel(event.outcome);
}

/** The `decidedBy` slug in the words a person would use. Only the ones that
    would read wrong raw are mapped — `grant`, `rule`, `judge` already say
    what they mean. "denied" alone reads as a fresh refusal; what actually
    happened is that an earlier no is still standing. */
const DECIDED_BY_LABEL: Record<string, string> = {
  denied: "previously denied",
  confirmEach: "confirm-each",
  default: "the default posture",
};

export function decidedByLabel(decidedBy: string): string {
  return DECIDED_BY_LABEL[decidedBy] ?? decidedBy;
}

const KIND_LABEL: Record<AuditEvent["kind"], string> = {
  "tool-call": "Tool",
  approval: "Approval",
  "policy-decision": "Policy",
  // Read on its own only for a venue outside the four doors (an older row) —
  // otherwise a run row is named by the door it arrived through.
  run: "Run",
  "app-lifecycle": "App",
  share: "Share",
  "door-auth": "Connection",
  principal: "Identity",
};

/**
 * A run is the generic unit; the VENUE is which door it came through (01-core
 * §7 carries `venue` on every row for exactly this). Calling every run an
 * "Automation" was false on three of the four doors, and since the chat door
 * started writing run rows it was false on the busiest one — seven rows on a
 * user's own activity rail claiming automations had run when none had.
 */
const RUN_VENUE: Record<AuditEvent["venue"], { badge: string; action: string }> = {
  chat: { badge: "Chat", action: "Chat turn" },
  app: { badge: "App", action: "App run" },
  automation: { badge: "Automation", action: "Automation run" },
  mcp: { badge: "Agent", action: "Connected agent run" },
};

/** Turn an audit event into the two readable strings a row shows: a short kind
    badge and a concrete action phrase. Tool-bearing kinds name the humanized
    tool (host metadata wins, else the prettified slug — never a raw id); the
    remaining kinds each get a plain-language phrase so no row is a mystery. */
export function describeActivity(
  event: AuditEvent,
  tools?: ToolMetaMap,
): { kindLabel: string; action: string } {
  const venue = RUN_VENUE[event.venue];
  const kindLabel = event.kind === "run" && venue !== undefined ? venue.badge : KIND_LABEL[event.kind];
  const tool = event.tool ? toolTitle(event.tool, tools?.[event.tool]) : undefined;
  const action = actionPhrase(event, tool);
  return { kindLabel, action };
}

function actionPhrase(event: AuditEvent, tool: string | undefined): string {
  switch (event.kind) {
    case "tool-call":
      return tool ?? "Tool call";
    case "approval":
      return tool ? `Approval: ${tool}` : "Approval request";
    case "door-auth":
      return "Account connected";
    case "run": {
      // A hire is staffing, not a run of the thread it happened inside — the
      // runtime gives it its own row, so it gets its own sentence.
      const detail = (event.detail ?? {}) as { subagent?: unknown };
      if (typeof detail.subagent === "object" && detail.subagent !== null) return "Specialist hired";
      return RUN_VENUE[event.venue]?.action ?? "Run";
    }
    case "policy-decision":
      // A policy decision is ABOUT a tool call — name it so the row isn't a
      // mystery (and so a reader can tell which action was gated).
      return tool ? `Policy decision: ${tool}` : "Policy decision";
    case "app-lifecycle":
      return "App updated";
    case "share":
      return "App shared";
    case "principal":
      return "Identity updated";
  }
}

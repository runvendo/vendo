/**
 * Real Composio execution for the Cadence automation's two write tools:
 * Gmail send + Google Calendar event creation, via the verified v3 REST
 * execute endpoint (same path demo-bank's Slack poster uses).
 *
 * Failures are reported truthfully — there is NO canned-success fallback here:
 * the demo beat's acceptance bar is a real email and a real calendar event,
 * so a failed send must look failed everywhere (run history included).
 */
import { DEMO_USER_ID } from "./principal";

const COMPOSIO_API = "https://backend.composio.dev/api/v3";

export interface ComposioFireResult {
  ok: boolean;
  /** The Composio response payload (or error detail) for run-history display. */
  detail: unknown;
  error?: string;
}

/** The wire-format args the executor sends, exposed for tests. */
export function calendarArgs(input: CalendarCreateInput): Record<string, unknown> {
  // Normalize duration to Composio's contract: it rejects minutes >= 60, so
  // carry the overflow into hours. Without this, an approved "1-hour call"
  // automation sends its chase emails and THEN fails on the calendar step
  // (partial side effects) — dual-review PR #27.
  const rawHours = input.event_duration_hour ?? 0;
  const rawMinutes = input.event_duration_minutes ?? (rawHours > 0 ? 0 : 30);
  const totalMinutes = rawHours * 60 + rawMinutes;
  return {
    calendar_id: "primary",
    summary: input.summary,
    ...(input.description !== undefined ? { description: input.description } : {}),
    start_datetime: input.start_datetime,
    event_duration_hour: Math.floor(totalMinutes / 60),
    event_duration_minutes: totalMinutes % 60,
    ...(input.attendees !== undefined ? { attendees: input.attendees } : {}),
    timezone: input.timezone ?? "America/Los_Angeles",
  };
}

async function executeComposio(
  slug: string,
  args: Record<string, unknown>,
): Promise<ComposioFireResult> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return { ok: false, detail: null, error: "COMPOSIO_API_KEY not set" };
  try {
    const res = await fetch(`${COMPOSIO_API}/tools/execute/${slug}`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ user_id: DEMO_USER_ID, arguments: args }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      successful?: boolean;
      data?: unknown;
      error?: string | null;
    };
    if (json.successful) return { ok: true, detail: json.data ?? null };
    return { ok: false, detail: json.data ?? null, error: json.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: null, error: String(e) };
  }
}

export interface GmailSendInput {
  recipient_email: string;
  subject: string;
  body: string;
}

export function sendGmail(input: GmailSendInput): Promise<ComposioFireResult> {
  return executeComposio("GMAIL_SEND_EMAIL", {
    recipient_email: input.recipient_email,
    subject: input.subject,
    body: input.body,
  });
}

export interface CalendarCreateInput {
  summary: string;
  description?: string;
  /** Naive local datetime, e.g. "2026-07-03T10:00:00" (no offset/Z). */
  start_datetime: string;
  event_duration_hour?: number;
  /** 0-59 only — Composio rejects 60+; use event_duration_hour instead. */
  event_duration_minutes?: number;
  attendees?: string[];
  timezone?: string;
}

export function createCalendarEvent(input: CalendarCreateInput): Promise<ComposioFireResult> {
  return executeComposio("GOOGLECALENDAR_CREATE_EVENT", calendarArgs(input));
}

/** Injectable seams so the automations world is testable offline. */
export type GmailSender = typeof sendGmail;
export type CalendarCreator = typeof createCalendarEvent;

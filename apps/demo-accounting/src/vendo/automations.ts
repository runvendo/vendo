/**
 * Cadence's embedded automations world — the ENG-188 engine wired into the
 * practice-management demo with the in-memory store, the in-process scheduler,
 * and three registered tools:
 *
 *  - `get_deadlines` (read): every client with document progress, what is
 *    still missing, the filing deadline and a computed daysUntilDeadline —
 *    everything the demo beat's guards need.
 *  - `GMAIL_SEND_EMAIL` (write, gated): a REAL Composio Gmail send.
 *  - `GOOGLECALENDAR_CREATE_EVENT` (write, gated): a REAL Composio Calendar
 *    booking on the user's primary calendar.
 *
 * The chat agent compiles plain English ("every morning, email any clients
 * missing docs; book a call with anyone within 3 days of a deadline") into an
 * inspectable spec via create_automation; the AutomationCard approval mints
 * scope-hashed grants for the two gated sends, so scheduled firings run
 * unattended. `run_automation_now` (live: true) is the demonstrable force-fire.
 *
 * Module-level singleton like Cadence's own store; the demo reset re-creates
 * it, and `generation` lets the chat route drop agents built against a dead
 * world.
 */
import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";
import type { Principal } from "@vendoai/core";
import {
  AutomationRunner,
  InAppChannels,
  InMemoryAutomationStore,
  InProcessScheduler,
  buildAutomationInstructions,
  createAgentStepRunner,
  createAutomationTools,
  createSchedulerFiringHandler,
  type AutomationEngineStore,
  type RegisteredTool,
} from "@vendoai/runtime";
import { listDeadlineEntries } from "@/server/clients";
import { getStore } from "@/server/store";
import { transitionDocument, type DocumentAction } from "@/server/documents";
import { demoPolicy } from "./policy";
import { demoStore } from "./store";
import { CADENCE_SCOPE, DEMO_USER_ID, DEMO_USER_NAME } from "./principal";
import {
  createCalendarEvent as realCreateCalendarEvent,
  sendGmail as realSendGmail,
  type CalendarCreator,
  type GmailSender,
} from "./composio-fire";

const DEMO_MODEL = process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6";

/** The demo's Principal: one fixed tenant + the Composio-authorized subject.
 *  Defined in `./principal` (a dependency-free leaf) — re-exported here for
 *  existing/plan call sites that import it from this module. */
export { CADENCE_SCOPE };

/** What the automation reads per client (the trigger-independent world view). */
export function deadlineWorldView() {
  const now = Date.now();
  return listDeadlineEntries().map((c) => ({
    id: c.id,
    businessName: c.businessName,
    contactName: c.contactName,
    contactEmail: c.contactEmail,
    entityType: c.entityType,
    filingDeadline: c.filingDeadline,
    // floor: a deadline 3 days + 5 hours away is "3 days out" — "within 3
    // days" must catch it (the seed sets deadlines at 17:00 local).
    daysUntilDeadline: Math.floor((+new Date(c.filingDeadline) - now) / 86_400_000),
    status: c.status,
    progress: c.progress,
    missingDocKinds: c.missingDocKinds,
  }));
}

export interface CreateWorldOptions {
  /** Injectable senders (tests stub them; production fires for real). */
  gmail?: GmailSender;
  calendar?: CalendarCreator;
  /** Model for agent steps; defaults to the demo model. */
  model?: LanguageModel;
  now?: () => string;
}

export interface CadenceAutomationsWorld {
  scope: Principal;
  store: AutomationEngineStore;
  runner: AutomationRunner;
  scheduler: InProcessScheduler;
  /** In-app deliveries (VendoToasts): the client polls /api/vendo/deliveries. */
  channels: InAppChannels;
  /** The chat agent's authoring toolset (create/update/list/pause/run-now…). */
  authoringTools(threadId?: string): ToolSet;
  /** Drive due schedules (the client poller ticks this; no timers needed in dev). */
  tick(): Promise<void>;
}

export function createAutomationsWorld(opts: CreateWorldOptions = {}): CadenceAutomationsWorld {
  const gmail = opts.gmail ?? realSendGmail;
  const calendar = opts.calendar ?? realCreateCalendarEvent;
  const store = new InMemoryAutomationStore(opts.now ? { now: opts.now } : {});

  // Content idempotency: a rehearsal re-fire on demo day must not double-send
  // or double-book. Key each REAL side effect by (recipient/attendee, day) and
  // skip a repeat. World-scoped, so a demo reset (which recreates the world)
  // intentionally clears it and lets the next run send fresh. Keys are added
  // only AFTER a successful send, so a failed send stays retryable.
  const doneKeys = new Set<string>();
  const sendDay = (): string => (opts.now ? opts.now() : new Date().toISOString()).slice(0, 10);

  const getDeadlines: RegisteredTool = {
    descriptor: {
      name: "get_deadlines",
      source: "caller",
      annotations: { readOnlyHint: true },
      hasExecute: true,
      kind: "function",
    },
    description:
      "All of the firm's clients ordered by filing deadline (soonest first). Each row: id, " +
      "businessName, contactName, contactEmail, entityType, filingDeadline (ISO), " +
      "daysUntilDeadline (number), status (missing_docs|in_review|complete), " +
      "progress { received, total }, missingDocKinds (string[] — empty when nothing is missing).",
    modelInputSchema: { type: "object", properties: {} },
    inputSchema: z.object({}),
    execute: async () => {
      try {
        return { ok: true, result: { clients: deadlineWorldView() } };
      } catch (err) {
        return { ok: false, error: { code: "host_error", message: String(err) } };
      }
    },
  };

  const gmailSend: RegisteredTool = {
    descriptor: {
      name: "GMAIL_SEND_EMAIL",
      source: "composio",
      annotations: {},
      hasExecute: true,
      kind: "function",
    },
    description:
      "Send a REAL email from the firm's Gmail. Input: { recipient_email, subject, body }.",
    modelInputSchema: {
      type: "object",
      properties: {
        recipient_email: { type: "string", description: "Primary recipient's email address." },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text email body." },
      },
      required: ["recipient_email", "subject", "body"],
    },
    inputSchema: z.object({
      recipient_email: z.string(),
      subject: z.string(),
      body: z.string(),
    }),
    execute: async (input) => {
      const recipient = String(input["recipient_email"]);
      const key = `gmail:${recipient}:${sendDay()}`;
      if (doneKeys.has(key)) {
        return { ok: true, result: { skipped: true, reason: "already emailed today", recipient } };
      }
      const result = await gmail({
        recipient_email: recipient,
        subject: String(input["subject"]),
        body: String(input["body"]),
      });
      if (result.ok) {
        doneKeys.add(key);
        return { ok: true, result };
      }
      return {
        ok: false,
        error: { code: "gmail_error", message: result.error ?? "Gmail send failed" },
      };
    },
  };

  const calendarCreate: RegisteredTool = {
    descriptor: {
      name: "GOOGLECALENDAR_CREATE_EVENT",
      source: "composio",
      annotations: {},
      hasExecute: true,
      kind: "function",
    },
    description:
      "Book a REAL event on the user's primary Google Calendar. Input: { summary, " +
      "start_datetime ('YYYY-MM-DDTHH:MM:SS', naive local time, NO offset/Z), " +
      "event_duration_minutes (0-59; use event_duration_hour for longer), " +
      "attendees? (email[]), description?, timezone? (IANA, default America/Los_Angeles) }.",
    modelInputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title." },
        description: { type: "string" },
        start_datetime: {
          type: "string",
          description: "Naive local datetime 'YYYY-MM-DDTHH:MM:SS' — no offsets or Z.",
        },
        event_duration_hour: { type: "number", description: "Hours (default 0)." },
        event_duration_minutes: { type: "number", description: "Minutes 0-59 (default 30)." },
        attendees: { type: "array", items: { type: "string" }, description: "Attendee emails." },
        timezone: { type: "string", description: "IANA timezone (default America/Los_Angeles)." },
      },
      required: ["summary", "start_datetime"],
    },
    inputSchema: z.object({
      summary: z.string(),
      description: z.string().optional(),
      start_datetime: z.string(),
      event_duration_hour: z.number().optional(),
      event_duration_minutes: z.number().optional(),
      attendees: z.array(z.string()).optional(),
      timezone: z.string().optional(),
    }),
    execute: async (input) => {
      // Dedup by (attendee-or-summary, event day) so a re-fire the same day
      // does not book a second identical event.
      const attendees = Array.isArray(input["attendees"]) ? (input["attendees"] as string[]) : [];
      const who = attendees.length > 0 ? attendees.join(",") : String(input["summary"]);
      const day = String(input["start_datetime"]).slice(0, 10);
      const key = `cal:${who}:${day}`;
      if (doneKeys.has(key)) {
        return { ok: true, result: { skipped: true, reason: "already booked", who, day } };
      }
      const result = await calendar({
        summary: String(input["summary"]),
        ...(input["description"] !== undefined ? { description: String(input["description"]) } : {}),
        start_datetime: String(input["start_datetime"]),
        ...(typeof input["event_duration_hour"] === "number"
          ? { event_duration_hour: input["event_duration_hour"] }
          : {}),
        ...(typeof input["event_duration_minutes"] === "number"
          ? { event_duration_minutes: input["event_duration_minutes"] }
          : {}),
        ...(Array.isArray(input["attendees"]) ? { attendees: input["attendees"] as string[] } : {}),
        ...(input["timezone"] !== undefined ? { timezone: String(input["timezone"]) } : {}),
      });
      if (result.ok) {
        doneKeys.add(key);
        return { ok: true, result };
      }
      return {
        ok: false,
        error: { code: "calendar_error", message: result.error ?? "Calendar booking failed" },
      };
    },
  };

  // ENG-193 item-4 demo fixture (same precedent as item 2's `x-vendo-dangerous`
  // on setDocumentStatus in openapi.json): the ONLY critical-tier tool Cadence
  // has, exposed to the automation world so a for_each can route a critical
  // action through parking — a critical park ALWAYS parks, even with a grant,
  // and renders the WaitingList's ceremony row. Demo-scoped classification,
  // not a product claim.
  const documentsForReview: RegisteredTool = {
    descriptor: {
      name: "get_documents_for_review",
      source: "caller",
      annotations: { readOnlyHint: true },
      hasExecute: true,
      kind: "function",
    },
    description:
      "Every uploaded client document awaiting firm review (status received or needs_review). " +
      "Each row: docId, clientId, businessName, kind, status, note (why it was flagged, when present).",
    modelInputSchema: { type: "object", properties: {} },
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const store = getStore();
        const documents = store.documents
          .filter((d) => d.status === "received" || d.status === "needs_review")
          .map((d) => ({
            docId: d.id,
            clientId: d.clientId,
            businessName:
              store.clients.find((c) => c.id === d.clientId)?.businessName ?? d.clientId,
            kind: d.kind,
            status: d.status,
            ...(d.note !== undefined ? { note: d.note } : {}),
          }));
        return { ok: true, result: { documents } };
      } catch (err) {
        return { ok: false, error: { code: "host_error", message: String(err) } };
      }
    },
  };

  const setDocumentStatus: RegisteredTool = {
    descriptor: {
      name: "set_document_status",
      source: "caller",
      // Mirrors openapi.json's `"x-vendo-dangerous": true` on the same
      // operation (item-2 fixture): destructive → critical tier → inside a
      // for_each it ALWAYS parks for the ceremony approval, never runs
      // unattended (ENG-193 §8).
      annotations: { destructiveHint: true },
      hasExecute: true,
      kind: "function",
    },
    description:
      "Advance a client document through its review lifecycle: 'verify' confirms it, 'reject' " +
      "returns it to missing with a reason the client sees. Input: { docId, action, reason? }.",
    modelInputSchema: {
      type: "object",
      properties: {
        docId: { type: "string", description: "Document request id (from get_documents_for_review)." },
        action: { type: "string", enum: ["verify", "reject"], description: "Lifecycle transition." },
        reason: { type: "string", description: "Why it was rejected (reject only)." },
      },
      required: ["docId", "action"],
    },
    inputSchema: z.object({
      docId: z.string(),
      action: z.enum(["verify", "reject"]),
      reason: z.string().optional(),
    }),
    execute: async (input) => {
      try {
        const doc = transitionDocument(
          String(input["docId"]),
          String(input["action"]) as DocumentAction,
          input["reason"] !== undefined ? { reason: String(input["reason"]) } : {},
        );
        return { ok: true, result: { docId: doc.id, status: doc.status } };
      } catch (err) {
        return {
          ok: false,
          error: { code: "document_error", message: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  };

  const registered: Record<string, RegisteredTool> = {
    get_deadlines: getDeadlines,
    GMAIL_SEND_EMAIL: gmailSend,
    GOOGLECALENDAR_CREATE_EVENT: calendarCreate,
    get_documents_for_review: documentsForReview,
    set_document_status: setDocumentStatus,
  };

  const channels = new InAppChannels();
  const runner = new AutomationRunner({
    store,
    tools: async () => registered,
    policy: demoPolicy,
    userClaims: async () => ({ id: DEMO_USER_ID, name: DEMO_USER_NAME }),
    agentRunner: createAgentStepRunner({ model: opts.model ?? anthropic(DEMO_MODEL) }),
    // ENG-193 §4.6/§6.2: a parked-action resolution gets the SAME "consent"
    // audit trail chat approvals already do (CADENCE_SCOPE is already
    // Principal-shaped, so the runner's default identity auditPrincipal is
    // correct — no mapping needed).
    audit: demoStore.audit,
    channels,
    ...(opts.now ? { now: opts.now } : {}),
  });

  const scheduler = new InProcessScheduler();
  scheduler.onFire(createSchedulerFiringHandler(runner));

  const authoringTools = (threadId?: string): ToolSet =>
    createAutomationTools({
      store,
      runner,
      scheduler,
      principal: CADENCE_SCOPE,
      registeredTools: async () => registered,
      hostEvents: [],
      ...(threadId !== undefined ? { createdFromThreadId: threadId } : {}),
    });

  return {
    scope: CADENCE_SCOPE,
    store,
    runner,
    scheduler,
    channels,
    authoringTools,
    tick: () => scheduler.tick(),
  };
}

/** The system-prompt block the demo agent appends (compiler guidance). */
export function demoAutomationInstructions(): string {
  return [
    buildAutomationInstructions({ hostEvents: [] }),
    "",
    "Tools available INSIDE automations (the automation closed world):",
    "- get_deadlines: read every client with contactEmail, filingDeadline,",
    "  daysUntilDeadline, status, missingDocKinds (read-only).",
    '- GMAIL_SEND_EMAIL: send a real email — input { "recipient_email", "subject", "body" }.',
    '- GOOGLECALENDAR_CREATE_EVENT: book a real calendar event — input { "summary",',
    '  "start_datetime" ("YYYY-MM-DDTHH:MM:SS", naive local), "event_duration_minutes" (0-59),',
    '  "attendees"?, "description"? }.',
    "- get_documents_for_review: every uploaded document awaiting firm review",
    "  (status received|needs_review) with docId/clientId/businessName/kind/status (read-only).",
    '- set_document_status: verify or reject a reviewed document — input { "docId",',
    '  "action" ("verify"|"reject"), "reason"? }. DANGEROUS/irreversible tier: inside an',
    "  automation it always parks for the user's explicit approval; it can never be granted.",
    "",
    "For 'every morning' schedules use cron '0 8 * * *' with timezone 'America/Los_Angeles'",
    "unless the user says otherwise. A client is 'missing documents' when status is",
    "'missing_docs' (missingDocKinds lists what is owed); 'within N days of a deadline'",
    "means daysUntilDeadline <= N (and >= 0). When emailing a client, write a short,",
    "professional chase note from Maya Alvarez at Hartwell & Associates that names the",
    "missing documents. When booking a call, put the client's contactEmail in attendees",
    "and reference the business name in the summary.",
    "",
    "SPEC PITFALLS — get these right the FIRST time:",
    "- A for_each `items` value MUST be exactly one {{ expr }} interpolation, e.g.",
    "  \"{{ steps.fetch.output.clients[status = 'missing_docs'] }}\". A bare expression",
    "  string without {{ }} is treated as a LITERAL and the step fails with 'items",
    "  expression did not produce an array'.",
    "- get_deadlines returns { clients: [...] } — filter steps.<id>.output.clients,",
    "  never steps.<id>.output directly.",
    "- GOOGLECALENDAR_CREATE_EVENT start_datetime must be NAIVE local time with no",
    "  offset/Z. Derive it from the firing time, e.g.",
    "  \"{{ $substring(run.firedAt, 0, 10) & 'T14:00:00' }}\" for 2 PM on the fire date.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Module-level singleton (like Cadence's own store). Reset re-creates it.

let world: CadenceAutomationsWorld = createAutomationsWorld();
let generation = 0;

export function automationsWorld(): CadenceAutomationsWorld {
  return world;
}

/** Bumps on reset — the chat route keys its agent cache on this. */
export function automationsGeneration(): number {
  return generation;
}

export function resetAutomations(): void {
  world = createAutomationsWorld();
  generation += 1;
}

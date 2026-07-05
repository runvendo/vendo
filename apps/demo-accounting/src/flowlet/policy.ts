/**
 * The Cadence demo's guardrail policy, layered on the @flowlet/runtime policy
 * machinery (same shape as demo-bank's — the automation grant/approval path
 * depends on these decisions):
 *
 * - Client-executed host-API tools (the OpenAPI adapter) carry real MCP-style
 *   annotations — decide from those (reads auto-allow, mutations approve).
 * - In-process read tools and automation-authoring reads are allowlisted.
 * - Composio tools (chat-ingested AND the automation world's registered
 *   GMAIL_SEND_EMAIL / GOOGLECALENDAR_CREATE_EVENT) decide by verb segment:
 *   read verbs run freely, write verbs require approval — which is exactly
 *   what makes the AutomationCard mint grants for the two sends.
 * - Everything else fails safe to approval.
 *
 * ENG-193 item 2 (§4.3/§6.2): the exported `demoPolicy` composes the item-1
 * primitives (audit + standing grants) onto this app's REAL base decision
 * layer, `namePolicy` (the ENG-193 item-2 plan's "Plan deviations" #4 — the
 * scope ruling's bare `annotationPolicy()` snippet is illustrative; wrapping
 * the host's actual base layer is the intent, matching what
 * `packages/flowlet-next/src/policy-stack.ts` does for the production path).
 * `contextKey: threadId` lets a fade/session grant (later items) match within
 * one conversation; the standing grants item 2 mints ignore it.
 *
 * ENG-193 item 3 (§4.2/§4.7): `demoPolicy` also composes the judge and the
 * deterministic breakers — OFF by default (no `FLOWLET_JUDGE_MODEL` set), so
 * `policy.test.ts` and CI never make a live model call and `demoPolicy`
 * behaves EXACTLY as item 2 shipped.
 */
import { anthropic } from "@ai-sdk/anthropic";
import {
  annotationPolicy,
  auditPolicy,
  composePolicy,
  compiledRulesPolicy,
  grantPolicy,
  judgePolicy,
  volumeBreaker,
  cautionBreaker,
  createBreakerState,
  type ApprovalPolicy,
} from "@flowlet/runtime";
import { READ_ONLY_TOOLS } from "./tools";
import { demoStore, CADENCE_SCOPE } from "./store";

/** In-process tools that are safe by construction (incl. read-shaped
 *  automation authoring; create/update/delete/pause/run-now stay gated). */
const ALWAYS_ALLOW = new Set<string>([
  "render_view",
  "list_automations",
  "get_automation_runs",
  // In-process read tool registered for the automation world (ENG-193 item-4
  // fixture beside set_document_status in automations.ts) — read-only by
  // construction, same class as get_deadlines.
  "get_documents_for_review",
  ...READ_ONLY_TOOLS,
]);

/** Read-shaped external (Composio) verb segments — safe to run freely. */
const READ_VERBS = new Set(["FETCH", "GET", "LIST", "SEARCH", "FIND", "READ"]);
/** Write/destructive verb segments — always gated behind approval. */
const WRITE_VERBS = new Set(["SEND", "CREATE", "DELETE", "UPDATE", "REPLACE", "ADD", "SET", "POST", "REMOVE", "WRITE"]);

/** Annotation-driven decisions for Cadence's own API tools (ENG-202). */
const hostAnnotations = annotationPolicy();

const namePolicy: ApprovalPolicy = {
  evaluate(ctx) {
    const { toolName } = ctx;
    // Host-API tools (client-executed, from the OpenAPI adapter) carry real
    // mutating/dangerous annotations — decide from those, not from name shape
    // (camelCase operationIds have no verb segments to match).
    if (ctx.descriptor.executor === "client") return hostAnnotations.evaluate(ctx);
    if (ALWAYS_ALLOW.has(toolName)) return "allow";
    // Composio names are underscore-delimited segments (TOOLKIT_VERB_OBJECT).
    // Match verbs as whole segments, and let any write-verb segment take
    // precedence so e.g. GOOGLEDOCS_FIND_AND_REPLACE (FIND + REPLACE) is gated.
    const segments = toolName.split("_");
    if (segments.some((s) => WRITE_VERBS.has(s))) return "approve";
    if (segments.some((s) => READ_VERBS.has(s))) return "allow";
    return "approve"; // fail-safe: gate the unknown
  },
};

/**
 * Optional judge model (ENG-193 §4.2) — OFF by default (undefined) so
 * `policy.test.ts` and CI never make a live model call: with no
 * FLOWLET_JUDGE_MODEL set, `judgePolicy` is pure identity and `demoPolicy`
 * behaves EXACTLY as item 2 shipped. Set it to a model id (a small/fast one
 * is enough — the judge is a classifier, not a generator — e.g.
 * "claude-haiku-4-5") to turn the judge on for a live verification pass.
 */
const JUDGE_MODEL_NAME = process.env.FLOWLET_JUDGE_MODEL;
const judgeModel = JUDGE_MODEL_NAME ? anthropic(JUDGE_MODEL_NAME) : undefined;

const breakerState = createBreakerState();

export const demoPolicy: ApprovalPolicy = composePolicy(
  volumeBreaker(
    cautionBreaker(
      judgePolicy(
        grantPolicy(namePolicy, demoStore.grants, {
          principalScope: () => CADENCE_SCOPE,
          contextKey: (ctx) => ctx.threadId,
        }),
        { model: judgeModel },
      ),
      breakerState,
    ),
    breakerState,
  ),
  // ENG-193 item 6: a matching always-ask rule beats any grant/judge/breaker
  // allow — a sibling, mirrors packages/flowlet-next/src/policy-stack.ts.
  compiledRulesPolicy(demoStore.rules, { principalScope: () => CADENCE_SCOPE }),
  // LAST on purpose — auditPolicy's evaluate must observe the escalation
  // reason the chain stamped, so a DECLINED escalation still gets its
  // judge_escalation trail entry (see audit-policy.ts's composition contract).
  auditPolicy(demoStore.audit, { principalScope: () => CADENCE_SCOPE }),
);

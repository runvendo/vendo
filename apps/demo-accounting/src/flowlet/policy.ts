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
 */
import { annotationPolicy, composePolicy, type ApprovalPolicy } from "@flowlet/runtime";
import { READ_ONLY_TOOLS } from "./tools";

/** In-process tools that are safe by construction (incl. read-shaped
 *  automation authoring; create/update/delete/pause/run-now stay gated). */
const ALWAYS_ALLOW = new Set<string>([
  "render_view",
  "list_automations",
  "get_automation_runs",
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

export const demoPolicy = composePolicy(namePolicy);

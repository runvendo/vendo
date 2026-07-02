/**
 * The Maple demo's REAL guardrail policy (replaces the old allow-all).
 *
 * Layered on the @flowlet/runtime policy machinery: one deterministic name-based
 * layer. Render + in-process demo tools and read-shaped external tools run
 * freely; anything write-shaped or unknown requires approval. The same policy
 * governs automation firings: the interpreter evaluates it per step, and an
 * approve-gated step runs unattended only under a scope-hashed grant.
 */
import { annotationPolicy, composePolicy, type ApprovalPolicy } from "@flowlet/runtime";

/** In-process tools that are safe by construction (incl. read-shaped
 *  automation authoring; create/update/delete/pause/run-now stay gated). */
const ALWAYS_ALLOW = new Set([
  "render_view",
  "request_connect",
  "get_transactions",
  "list_automations",
  "get_automation_runs",
]);

/** Read-shaped external (Composio) verb segments — safe to run freely. */
const READ_VERBS = new Set(["FETCH", "GET", "LIST", "SEARCH", "FIND", "READ"]);
/** Write/destructive verb segments — always gated behind approval. */
const WRITE_VERBS = new Set(["SEND", "CREATE", "DELETE", "UPDATE", "REPLACE", "ADD", "SET", "POST", "REMOVE", "WRITE"]);

/** Annotation-driven decisions for Maple's own API tools (ENG-202). */
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
    // An unanchored substring test here would auto-allow write tools whose name
    // merely contains a read word (e.g. BUDGET_CREATE contains "GET").
    const segments = toolName.split("_");
    if (segments.some((s) => WRITE_VERBS.has(s))) return "approve";
    if (segments.some((s) => READ_VERBS.has(s))) return "allow";
    return "approve"; // fail-safe: gate the unknown
  },
};

export const demoPolicy = composePolicy(namePolicy);

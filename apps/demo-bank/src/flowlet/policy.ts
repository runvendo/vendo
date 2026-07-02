/**
 * The Maple demo's REAL guardrail policy (replaces the old allow-all).
 *
 * Layered on the @flowlet/agent policy machinery: one deterministic name-based
 * layer. Render + in-process demo tools and read-shaped external tools run
 * freely; anything write-shaped or unknown requires approval. Beat 3's Slack
 * post is unaffected: the poller posts server-side under the user's standing
 * natural-language rule, not through an agent tool call.
 */
import { composePolicy, type ApprovalPolicy } from "@flowlet/agent";

/** In-process tools that are safe by construction. */
const ALWAYS_ALLOW = new Set(["render_ui", "render_view", "request_connect", "get_transactions", "set_rule"]);

/** Read-shaped external (Composio) verb segments — safe to run freely. */
const READ_VERBS = new Set(["FETCH", "GET", "LIST", "SEARCH", "FIND", "READ"]);
/** Write/destructive verb segments — always gated behind approval. */
const WRITE_VERBS = new Set(["SEND", "CREATE", "DELETE", "UPDATE", "REPLACE", "ADD", "SET", "POST", "REMOVE", "WRITE"]);

const namePolicy: ApprovalPolicy = {
  evaluate({ toolName }) {
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

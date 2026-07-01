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
const ALWAYS_ALLOW = new Set(["render_ui", "render_view", "get_transactions", "set_rule"]);

/** Read-shaped external (Composio) tool names. */
const READ_SHAPED = /(FETCH|GET|LIST|SEARCH|FIND|READ)/;

const namePolicy: ApprovalPolicy = {
  evaluate({ toolName }) {
    if (ALWAYS_ALLOW.has(toolName)) return "allow";
    if (READ_SHAPED.test(toolName)) return "allow";
    return "approve"; // fail-safe: gate writes and the unknown
  },
};

export const demoPolicy = composePolicy(namePolicy);

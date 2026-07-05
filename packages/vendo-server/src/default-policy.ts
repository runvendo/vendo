/**
 * The handler's ZERO-CONFIG guardrail policy — the default an OSS install
 * runs with when the host passes no `policy` option. Deliberately
 * conservative: reads run freely only when something explicitly marks them safe;
 * everything else pauses for the user's approval. Layers:
 *
 * 1. Client-executed host-API tools → annotation policy (the manifest's
 *    reviewed `mutating`/`dangerous` flags are the source of truth).
 * 2. The engine's own UI tools + automation authoring reads → allow
 *    (safe by construction; authoring writes fall through and gate).
 * 3. Server tools carrying informative annotation hints → annotation policy.
 * 4. Composio names (TOOLKIT_VERB_OBJECT) → whole-segment verb heuristic,
 *    any write verb wins over a read verb.
 * 5. Fail-safe: approve (gate the unknown).
 */
import { annotationPolicy, composePolicy, type ApprovalPolicy } from "@vendoai/runtime";

/** Engine-owned tools that are safe by construction. */
const ENGINE_ALLOW = new Set([
  "render_view",
  // Same capability class as render_view (server-materialized view through
  // identical gates); an approval per edit would erase the fast-edit win.
  "edit_view",
  "request_connect",
  "list_automations",
  "get_automation_runs",
]);

/** Read-shaped external (Composio) verb segments — safe to run freely. */
const READ_VERBS = new Set(["FETCH", "GET", "LIST", "SEARCH", "FIND", "READ"]);
/** Write/destructive verb segments — always gated behind approval. */
const WRITE_VERBS = new Set([
  "SEND", "CREATE", "DELETE", "UPDATE", "REPLACE", "ADD", "SET", "POST", "REMOVE", "WRITE",
]);

const annotations = annotationPolicy();

const layer: ApprovalPolicy = {
  evaluate(ctx) {
    const { toolName, descriptor } = ctx;
    // Host-API tools (client-executed) carry reviewed manifest annotations —
    // decide from those, not from name shape (camelCase operationIds have no
    // verb segments to match).
    if (descriptor.executor === "client") return annotations.evaluate(ctx);
    if (ENGINE_ALLOW.has(toolName)) return "allow";
    // Server tools that declare their safety get the same annotation logic.
    const hints = descriptor.annotations;
    if (hints.readOnlyHint !== undefined || hints.destructiveHint !== undefined) {
      return annotations.evaluate(ctx);
    }
    // Composio names are underscore-delimited segments (TOOLKIT_VERB_OBJECT).
    // 1) Any write-verb segment ANYWHERE gates it (GOOGLEDOCS_FIND_AND_REPLACE
    //    stays gated despite the leading read verb FIND).
    // 2) Auto-allow ONLY when the VERB position (segment 1, right after the
    //    toolkit) is a read verb. Requiring the read intent to be the verb —
    //    not merely present somewhere — stops mutating tools whose OBJECT reads
    //    like a read from slipping through (e.g. GMAIL_MARK_AS_READ: verb=MARK,
    //    not a read verb, so it falls through to the fail-safe).
    const segments = toolName.split("_");
    if (segments.some((s) => WRITE_VERBS.has(s))) return "approve";
    if (segments.length >= 2 && READ_VERBS.has(segments[1]!)) return "allow";
    return "approve"; // fail-safe: gate the unknown
  },
};

export const defaultVendoPolicy = composePolicy(layer);

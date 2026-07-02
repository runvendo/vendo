/**
 * The Gmail demo's guardrail policy, mirroring demo-bank's layering:
 *  - Host-API tools (client-executed, from the OpenAPI adapter) carry real
 *    annotations — decide from those (reads allow; sends/deletes approve).
 *  - In-process reads and the render/request tools run freely.
 *  - Everything else — delete_email, send_reply, slack_summary, unknowns —
 *    fails safe to "approve".
 */
import { annotationPolicy, composePolicy, type ApprovalPolicy } from "@flowlet/runtime";
import { READ_ONLY_TOOLS } from "./tools";

const ALWAYS_ALLOW = new Set(["render_view", "request_connect", ...READ_ONLY_TOOLS]);

const hostAnnotations = annotationPolicy();

const namePolicy: ApprovalPolicy = {
  evaluate(ctx) {
    if (ctx.descriptor.executor === "client") return hostAnnotations.evaluate(ctx);
    if (ALWAYS_ALLOW.has(ctx.toolName)) return "allow";
    return "approve"; // fail-safe: gate writes and the unknown
  },
};

export const demoPolicy = composePolicy(namePolicy);

/**
 * POST /api/vendo/action — the stage action host. A generated sandbox
 * component's `vendo.dispatch` lands here: the SAME policy that governs
 * agent tool calls decides allow/approve/deny, and allowed actions execute
 * against the handler's server tools.
 *
 * Approval flow: an `approve` decision returns `{ needsApproval, approvalToken }`
 * WITHOUT executing. The client shows the approval card and re-POSTs with the
 * token. Tokens are single-use, short-lived, and bound to the exact
 * (action, payload, user) triple — unlike a trusted `approved: true` re-POST, a
 * forged or replayed confirmation cannot execute a gated action.
 *
 * SCOPE — what the token is and isn't: it is a HUMAN-CONSENT binding (this
 * exact action+payload was shown to, and confirmed by, the user), not an
 * authorization gate. The authorization gate is upstream — `resolvePrincipal`
 * (who may call at all) plus the policy (what needs consent). An already-
 * authorized caller can, of course, script the two-step approve+execute for
 * their OWN actions; that is inherent to any endpoint that lets an authorized
 * user act, and topology B means they could hit the host API directly anyway.
 * The token exists to stop a DIFFERENT or REPLAYED payload from riding a
 * consent the user gave for something else.
 */
import { randomUUID } from "node:crypto";
import { buildDescriptor } from "@vendoai/runtime";
import type { ApprovalPolicy, VendoPrincipal, ToolDescriptor } from "@vendoai/runtime";
import { asSchema } from "ai";
import type { ToolSet } from "ai";
import { resolvePrincipal } from "./guard.js";
import type { VendoHandlerOptions } from "./options.js";

interface ActionBody {
  action?: string;
  payload?: unknown;
  approvalToken?: string;
}

interface PendingApproval {
  action: string;
  payloadJson: string;
  userId: string;
  expiresAtMs: number;
}

const APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface ApprovalStore {
  issue(action: string, payloadJson: string, userId: string): string;
  consume(token: string, action: string, payloadJson: string, userId: string): boolean;
}

export function createApprovalStore(now: () => number = Date.now): ApprovalStore {
  const pending = new Map<string, PendingApproval>();
  return {
    issue(action, payloadJson, userId) {
      // Opportunistic sweep so an abandoned card can't grow the map forever.
      for (const [token, entry] of pending) {
        if (entry.expiresAtMs <= now()) pending.delete(token);
      }
      const token = randomUUID();
      pending.set(token, { action, payloadJson, userId, expiresAtMs: now() + APPROVAL_TTL_MS });
      return token;
    },
    consume(token, action, payloadJson, userId) {
      const entry = pending.get(token);
      if (!entry) return false;
      pending.delete(token); // single-use, even on mismatch
      return (
        entry.expiresAtMs > now() &&
        entry.action === action &&
        entry.payloadJson === payloadJson &&
        entry.userId === userId
      );
    },
  };
}

export interface ActionDeps {
  /** The handler's server tools (host `tools` option + automation authoring). */
  getTools: () => ToolSet;
  policy: ApprovalPolicy;
  approvals: ApprovalStore;
  options: VendoHandlerOptions;
  /**
   * Review follow-up: resolves the descriptor via the SAME source mapping the
   * chat/consent path uses (`handler.ts`'s `resolveDescriptor` — host server
   * tools -> "engine", control tools -> "control", client tools -> "caller").
   * `hashDescriptor` (grant-match.ts) includes `source`, so a grant minted
   * against the chat-side descriptor (e.g. from a steering utterance or an
   * approved chat call) hashes differently than the "caller"-sourced
   * descriptor this route used to build unconditionally — the SAME host
   * server tool dispatched here never matched a standing grant minted from
   * chat. Optional only so isolated unit tests that construct `ActionDeps`
   * directly (not through the full handler assembly) don't need to wire it;
   * falls back to `buildDescriptor(action, tool, "caller")` when absent or
   * when the resolver doesn't know the name.
   */
  resolveDescriptor?: (toolName: string) => ToolDescriptor | undefined;
}

type ExecutableTool = {
  execute?: (input: unknown, opts: unknown) => Promise<unknown>;
  inputSchema?: unknown;
};

function jsonTypeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true; // unrecognized type keyword — don't block on it
  }
}

/**
 * Minimal JSON Schema check for the fallback below: enforces the three
 * constraints that matter for a fail-CLOSED action gate — declared `type`,
 * `required` presence, and `additionalProperties: false` — recursing into
 * object properties and array items. Deliberately NOT a full validator (no
 * formats, enums, numeric bounds); those tighten further but are not the hole.
 */
function validateAgainstJsonSchema(value: unknown, schema: unknown): boolean {
  if (schema === null || typeof schema !== "object") return true;
  const s = schema as Record<string, unknown>;
  const type = s["type"];
  if (typeof type === "string" && !jsonTypeMatches(value, type)) return false;
  if (Array.isArray(type) && !type.some((t) => typeof t === "string" && jsonTypeMatches(value, t))) {
    return false;
  }

  const isObj = value !== null && typeof value === "object" && !Array.isArray(value);
  if (isObj && (s["properties"] !== undefined || s["required"] !== undefined || type === "object")) {
    const obj = value as Record<string, unknown>;
    const properties = (s["properties"] ?? {}) as Record<string, unknown>;
    const required = Array.isArray(s["required"]) ? (s["required"] as string[]) : [];
    for (const key of required) {
      if (obj[key] === undefined) return false;
    }
    if (s["additionalProperties"] === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) return false;
      }
    }
    for (const [key, propSchema] of Object.entries(properties)) {
      if (obj[key] !== undefined && !validateAgainstJsonSchema(obj[key], propSchema)) return false;
    }
  }

  const items = s["items"];
  if (Array.isArray(value) && items !== null && typeof items === "object" && !Array.isArray(items)) {
    for (const el of value) {
      if (!validateAgainstJsonSchema(el, items)) return false;
    }
  }
  return true;
}

/**
 * Sandbox payloads are caller-shaped, and unlike the chat loop (where the ai
 * SDK validates model tool inputs at the model boundary) nothing upstream of
 * this route checks them — validate against the tool's own input schema
 * before executing. When the schema carries a runtime validator (zod / any
 * standard-schema tool) use it and return its parsed value. When it does NOT
 * (an AI SDK `jsonSchema()` tool — `asSchema(...).validate` is undefined), fall
 * back to our own JSON Schema check rather than failing open: no validator must
 * never mean "execute anything".
 */
async function validatePayload(tool: ExecutableTool, payload: unknown): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (tool.inputSchema === undefined) return { ok: true, value: payload };
  const schema = asSchema(tool.inputSchema as Parameters<typeof asSchema>[0]);
  if (schema.validate) {
    const result = await schema.validate(payload);
    return result.success ? { ok: true, value: result.value } : { ok: false };
  }
  const jsonSchema = await schema.jsonSchema;
  return validateAgainstJsonSchema(payload, jsonSchema) ? { ok: true, value: payload } : { ok: false };
}

export async function handleAction(req: Request, deps: ActionDeps): Promise<Response> {
  const guard = await resolvePrincipal(req, deps.options);
  if (!guard.ok) return guard.response;
  const principal: VendoPrincipal = guard.principal;

  const body = (await req.json().catch(() => ({}))) as ActionBody;
  if (typeof body.action !== "string" || body.action.length === 0) {
    return Response.json({ error: "action (string) is required" }, { status: 400 });
  }

  const tools = deps.getTools() as Record<string, ExecutableTool>;
  const tool = tools[body.action];
  const payload = body.payload ?? {};
  const payloadJson = JSON.stringify(payload);
  // One id for this dispatch, threaded through evaluate, the real execute,
  // AND onExecuted below — the SAME ctx wrapTool's own execute path builds
  // once and reuses, so a policy layer keyed on toolCallId (breakers'
  // escalation dedupe, audit's tool_execution event) sees a genuinely unique
  // id per action rather than a shared literal every dispatch collided on.
  const toolCallId = randomUUID();
  const descriptor =
    deps.resolveDescriptor?.(body.action) ?? buildDescriptor(body.action, tool, "caller");
  const ctx = {
    toolName: body.action,
    input: payload,
    descriptor,
    principal,
    toolCallId,
  };

  const decision = await deps.policy.evaluate(ctx);

  if (decision === "deny") {
    return Response.json({ decision, error: "denied by policy" }, { status: 403 });
  }
  if (decision === "approve") {
    const token = body.approvalToken;
    const confirmed =
      typeof token === "string" &&
      deps.approvals.consume(token, body.action, payloadJson, principal.userId);
    if (!confirmed) {
      return Response.json({
        decision,
        needsApproval: true,
        approvalToken: deps.approvals.issue(body.action, payloadJson, principal.userId),
      });
    }
  }
  if (!tool?.execute) {
    return Response.json({ error: `unknown action "${body.action}"` }, { status: 404 });
  }
  const validated = await validatePayload(tool, payload);
  if (!validated.ok) {
    // Generic on purpose: validator internals (expected types, enum values)
    // never cross to the sandbox caller.
    return Response.json({ error: `invalid payload for action "${body.action}"` }, { status: 400 });
  }
  const result = await tool.execute(validated.value, { toolCallId, messages: [] });
  // Review follow-up: sandbox dispatches through /action called evaluate +
  // execute but never onExecuted, so a successful dispatch was invisible to
  // the Trust diary's audit trail and to volume-breaker counting — the ONLY
  // execution path in this codebase that skipped it (wrapTool's execute
  // always calls it; see wrap-tool.ts). Mirrors that contract exactly: fired
  // only here, after a genuine successful execute, with the enforced
  // decision — never for `deny` (returned above, tool never ran) and never
  // if `tool.execute` throws (a throw propagates before this line runs).
  await deps.policy.onExecuted?.(ctx, decision);
  return Response.json({ decision, result });
}

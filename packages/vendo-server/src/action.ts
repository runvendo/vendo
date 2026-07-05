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
import type { ToolSet } from "ai";
import { resolvePrincipal } from "./guard";
import type { VendoHandlerOptions } from "./options";

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

type ExecutableTool = { execute?: (input: unknown, opts: unknown) => Promise<unknown> };

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
  const result = await tool.execute(payload, { toolCallId, messages: [] });
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

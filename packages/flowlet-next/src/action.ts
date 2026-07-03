/**
 * POST /api/flowlet/action — the stage action host. A generated sandbox
 * component's `flowlet.dispatch` lands here: the SAME policy that governs
 * agent tool calls decides allow/approve/deny, and allowed actions execute
 * against the handler's server tools.
 *
 * Approval flow: an `approve` decision returns `{ needsApproval, approvalToken }`
 * WITHOUT executing. The client shows the approval card and re-POSTs with the
 * token. Tokens are single-use, short-lived, and bound to the exact
 * (action, payload) pair — unlike a trusted `approved: true` re-POST, a forged
 * or replayed confirmation cannot execute a gated action.
 */
import { randomUUID } from "node:crypto";
import { buildDescriptor } from "@flowlet/runtime";
import type { ApprovalPolicy, FlowletPrincipal } from "@flowlet/runtime";
import type { ToolSet } from "ai";
import { resolvePrincipal } from "./guard";
import type { FlowletHandlerOptions } from "./options";

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
  options: FlowletHandlerOptions;
}

type ExecutableTool = { execute?: (input: unknown, opts: unknown) => Promise<unknown> };

export async function handleAction(req: Request, deps: ActionDeps): Promise<Response> {
  const guard = await resolvePrincipal(req, deps.options);
  if (!guard.ok) return guard.response;
  const principal: FlowletPrincipal = guard.principal;

  const body = (await req.json().catch(() => ({}))) as ActionBody;
  if (typeof body.action !== "string" || body.action.length === 0) {
    return Response.json({ error: "action (string) is required" }, { status: 400 });
  }

  const tools = deps.getTools() as Record<string, ExecutableTool>;
  const tool = tools[body.action];
  const payload = body.payload ?? {};
  const payloadJson = JSON.stringify(payload);

  const decision = await deps.policy.evaluate({
    toolName: body.action,
    input: payload,
    descriptor: buildDescriptor(body.action, tool, "caller"),
    principal,
  });

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
  const result = await tool.execute(payload, { toolCallId: "stage-action", messages: [] });
  return Response.json({ decision, result });
}

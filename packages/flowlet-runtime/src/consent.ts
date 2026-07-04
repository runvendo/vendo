/**
 * `handleConsent` — the server-validated grant-creation endpoint logic
 * (ENG-193 §4.5). A host mounts this behind its own HTTP route; this
 * module is transport-agnostic — no `Request`/`Response` here, so it is
 * testable without a server and portable to any route layer. It has TWO
 * production mounts in this plan: `@flowlet/next`'s catch-all (Task 5, the
 * production path demo-bank runs) and the accounting demo's hand-rolled
 * route (Task 7) — see "Plan deviations" #1.
 *
 * Steps (mirrors the ruling): (a) load the thread's messages via the Store
 * seam, (b) find the approval-requested part with the given toolCallId and
 * confirm its tool name matches, (c) resolve the LIVE descriptor via the
 * caller-supplied resolver (each mount's static-toolset lookup, Tasks 5/6),
 * (d) call `createGrantManager.create` — which self-derives criticality and
 * throws on a critical tool; that throw becomes this function's 403, (e)
 * append a "consent" audit event regardless of outcome (the audit trail
 * records EVERY decision, not just the ones that minted a grant).
 */
import type { AuditLog, ConsentResponse, FlowletUIMessage, GrantStore, Principal } from "@flowlet/core";
import type { ToolDescriptor } from "./descriptor";
import { createGrantManager } from "./grant-manager";

export interface HandleConsentDeps {
  grants: GrantStore;
  audit: AuditLog;
  resolveDescriptor: (toolName: string) => ToolDescriptor | undefined;
  /** Loads the thread's persisted messages (Task 3's onSettled writes them). */
  getMessages: (principal: Principal, threadId: string) => Promise<FlowletUIMessage[]>;
  now?: () => string;
}

export interface HandleConsentRequest {
  threadId: string;
  toolCallId: string;
  toolName: string;
  response: ConsentResponse;
}

export type HandleConsentResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404; error: string };

/** Structural view of the ai SDK tool-part shape this reads — matches
 *  `engine.ts`'s own `normalizeHistory` scanning, just keyed by toolCallId. */
interface ApprovalPart {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
}

function findApprovalPart(
  messages: FlowletUIMessage[],
  toolCallId: string,
): ApprovalPart | undefined {
  for (const message of messages) {
    for (const rawPart of message.parts) {
      const part = rawPart as ApprovalPart;
      if (
        part.type.startsWith("tool-") &&
        part.toolCallId === toolCallId &&
        (part.state === "approval-requested" || part.state === "approval-responded")
      ) {
        return part;
      }
    }
  }
  return undefined;
}

export async function handleConsent(
  deps: HandleConsentDeps,
  principal: Principal,
  req: HandleConsentRequest,
): Promise<HandleConsentResult> {
  const messages = await deps.getMessages(principal, req.threadId);
  const part = findApprovalPart(messages, req.toolCallId);
  if (!part) {
    return { ok: false, status: 404, error: `no pending approval for toolCallId "${req.toolCallId}"` };
  }
  const partToolName = part.type.slice("tool-".length);
  if (partToolName !== req.toolName) {
    return {
      ok: false, status: 400,
      error: `toolName "${req.toolName}" does not match the pending part's tool "${partToolName}"`,
    };
  }

  const clock = deps.now ?? (() => new Date().toISOString());
  const manager = createGrantManager({ store: deps.grants, audit: deps.audit, now: clock });

  if (req.response.decision === "yes" && req.response.grant) {
    const descriptor = deps.resolveDescriptor(req.toolName);
    if (!descriptor) {
      return { ok: false, status: 404, error: `unknown tool "${req.toolName}"` };
    }
    try {
      await manager.create(
        principal,
        {
          tool: req.response.grant.tool,
          scope: req.response.grant.scope,
          duration: req.response.grant.duration,
          source: { kind: "chat" },
        },
        descriptor,
      );
    } catch (err) {
      await deps.audit.append({
        at: clock(), principal, kind: "consent",
        consentId: req.response.id, decision: req.response.decision,
      });
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 403, error: message };
    }
  }

  await deps.audit.append({
    at: clock(), principal, kind: "consent",
    consentId: req.response.id, decision: req.response.decision,
  });
  return { ok: true };
}

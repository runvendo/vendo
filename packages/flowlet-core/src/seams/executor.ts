import type { BrokeredGrant } from "./credential-broker";
import type { Principal } from "./principal";

/**
 * Executor seam — where a tool call physically runs (Decisions 1/2).
 *
 * | Deployment | Implementation |
 * |---|---|
 * | Embedded | in-process against the host backend |
 * | Cloud, interactive | client executor: the call streams to the SDK, the browser fetches the host API on the user's session, the result returns via the ai SDK client-tool round trip |
 * | Cloud, automation | server executor in the worker, authorized by a BrokeredGrant |
 *
 * The runtime selects an executor per tool call; the policy layer has already
 * evaluated the call before it reaches any executor. Non-streaming by design:
 * a tool call resolves to one outcome (mirrors `ActionResult`).
 */
export interface Executor {
  execute(call: ToolCallRequest, context: ExecutionContext): Promise<ToolCallOutcome>;
}

export interface ToolCallRequest {
  /** ai SDK tool-call id — links outcome, approval, and audit entries. */
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ExecutionContext {
  principal: Principal;
  /** Present only on server-executed automation runs. */
  grant?: BrokeredGrant;
  signal?: AbortSignal;
}

export type ToolCallOutcome =
  | { result: unknown }
  | { error: { code: string; message: string } };

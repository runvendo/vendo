/**
 * TEMPORARY — replaced by core/guard exports at merge.
 *
 * Two sibling branches are changing the packages this one consumes, in
 * parallel with this build (agents-v0 spec, 2026-08-04):
 *
 * - guard extracts `GuardLike` (≈ core `Guard` + `bind`) and adds
 *   `onApprovalRequested`.
 * - core adds `user` / `context` / `messages` to `RunContext` and relaxes the
 *   five-seat `ResolvedModels` requirement.
 *
 * Everything here is the SPEC'S shape, declared minimally so this package
 * compiles against today's exports. The merge worker swaps these for the real
 * imports and deletes this file.
 */
import type {
  ApprovalDecision,
  ApprovalId,
  ApprovalRequest,
  Guard,
  Json,
  Principal,
  ResolvedModels,
  RunContext,
  ToolRegistry,
} from "@vendoai/core";
import type { LanguageModel, UIMessage } from "ai";

/**
 * The narrow guard every consumer codes against: core's `Guard` plus the one
 * binding choke point. `approvals` and `onApprovalRequested` are optional so
 * today's `VendoGuard` satisfies this structurally; both are feature-detected
 * where used.
 */
export interface GuardLike extends Guard {
  bind(tools: ToolRegistry): ToolRegistry;
  approvals?: {
    decide(
      ids: ApprovalId | ApprovalId[],
      decision: ApprovalDecision,
      principal: Principal,
    ): Promise<void>;
  };
  /** Fires when a check parks an approval; the return value unsubscribes. */
  onApprovalRequested?(cb: (request: ApprovalRequest) => void): () => void;
}

/**
 * `RunContext` with the session slots the spec adds: `user` (server-trust,
 * model-visible), `context` (guard/tools only; functions run at check-time,
 * data survives parking), `messages` (the turn's transcript, for the judge).
 */
export interface EnrichedRunContext extends RunContext {
  user?: Record<string, Json>;
  context?: Record<string, unknown>;
  messages?: readonly UIMessage[];
}

/**
 * The five-seat requirement is being relaxed: a runtime whose harness binds
 * its model at construction (`claudeCode({ model })`) has no seat to fill.
 * Until core lands that, an empty seat map is cast through.
 */
export const relaxedModels = (
  seats: Partial<ResolvedModels<LanguageModel>> = {},
): ResolvedModels<LanguageModel> => seats as ResolvedModels<LanguageModel>;

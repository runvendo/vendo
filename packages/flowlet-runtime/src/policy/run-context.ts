/**
 * Per-run mutable state the judge reads (ENG-193 §4.2): the driving user
 * request, which earlier tool RESULTS in THIS run are tainted
 * (openWorld/composio-sourced/unverified), and a running tool-call tally.
 * The engine creates exactly ONE instance per `run()` call (it already
 * rebuilds the toolset fresh per run) and threads it through `buildToolset`
 * -> `wrapTool`/`wrapClientTool`, which read a fresh snapshot on every
 * `evaluate` and update it after every genuinely-executed call.
 *
 * `recordCall` is invoked ONCE per tool call, from `needsApproval` (the SDK
 * calls that exactly once per generated call, whether the decision ends up
 * "allow" or "approve" — unlike `evaluate`, which both `needsApproval` AND
 * `execute` call, `needsApproval` alone would double-count nothing).
 * `recordResult` is invoked from `execute`, mirroring `onExecuted`'s own
 * contract: only after the real tool call genuinely succeeded (never for a
 * `deny`, never for a throw) — matching "results that ENTERED context",
 * which a denied or failed call never did.
 *
 * KNOWN LIMITATION (documented, not fixed here): client-executed host tools
 * (`wrapClientTool`, ENG-202 topology B) have no server-side `execute` to
 * observe a result from — the call runs in the browser and its content never
 * reaches this process. Their results can never taint provenance in v1; only
 * server-executed (engine/composio/caller-in-process) results do. The host
 * API remains the real authority for those tools regardless (spec §5).
 */
import type { ToolDescriptor } from "../descriptor";
import { isUnverified } from "./tier";

export interface RunPolicyContext {
  readonly request?: { text: string; messageId: string };
  /** Fresh copy — safe for a caller to hold or mutate without affecting state. */
  snapshotProvenance(): { taintedSources: string[] };
  /** Fresh copy — safe for a caller to hold or mutate without affecting state. */
  snapshotCounters(): { toolCallsThisTurn: number; perTool: Record<string, number> };
  /** Record that `toolName`'s call is being considered this run. */
  recordCall(toolName: string): void;
  /** Record a genuine execute's result, tainting the rest of the run if the
   *  descriptor warrants it (openWorld / composio-sourced / unverified). */
  recordResult(toolName: string, descriptor: ToolDescriptor): void;
}

function isTaintSource(descriptor: ToolDescriptor): boolean {
  return (
    descriptor.annotations.openWorldHint === true ||
    descriptor.source === "composio" ||
    isUnverified(descriptor)
  );
}

export function createRunPolicyContext(
  request?: { text: string; messageId: string },
): RunPolicyContext {
  const tainted = new Set<string>();
  let total = 0;
  const perTool: Record<string, number> = {};

  return {
    request,
    snapshotProvenance: () => ({ taintedSources: [...tainted] }),
    snapshotCounters: () => ({ toolCallsThisTurn: total, perTool: { ...perTool } }),
    recordCall(toolName) {
      total += 1;
      perTool[toolName] = (perTool[toolName] ?? 0) + 1;
    },
    recordResult(toolName, descriptor) {
      if (isTaintSource(descriptor)) tainted.add(toolName);
    },
  };
}

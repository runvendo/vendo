/** Automation and run transport (08-ui §3, 07-automations §1). */
import type { AutomationId, RunId } from "@vendoai/core";
import { useCallback } from "react";
import { useVendoProvider } from "../context.js";
import { type PollOptions, useResource } from "./use-resource.js";
import type { AutomationEntry, EnableResult, RunPlan, RunRecord, RunStatus } from "../wire-types.js";

export function useAutomations(options?: PollOptions): {
  automations: AutomationEntry[];
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
  /** Arm/disarm ONE record: an automation is armed on its own. */
  enable(id: AutomationId): Promise<EnableResult>;
  disable(id: AutomationId): Promise<void>;
  runs(filter?: {
    automationId?: AutomationId;
    owner?: string;
    agent?: string;
    status?: RunStatus;
    cursor?: string;
  }): Promise<{ runs: RunRecord[]; cursor?: string }>;
  dryRun(id: AutomationId): Promise<RunPlan>;
  stopRun(runId: RunId): Promise<void>;
  /** Run it again — a FRESH run of the same automation on the same triggering
   *  event (07 §1 `runs.rerun`). The remedy for a run that failed, and the second
   *  half of Grant & re-run: allow the permission, then this. Answers with the
   *  new run's id, and refreshes the list so its row is live. */
  rerun(runId: RunId): Promise<RunId>;
} {
  const { client } = useVendoProvider();
  const list = useCallback(() => client.automations.list(), [client]);
  const { data, error, isLoading, refresh } = useResource(list, [] as AutomationEntry[], options);

  const enable = useCallback(
    async (id: AutomationId) => {
      const result = await client.automations.enable(id);
      await refresh();
      return result;
    },
    [client, refresh],
  );
  const disable = useCallback(
    async (id: AutomationId) => {
      await client.automations.disable(id);
      await refresh();
    },
    [client, refresh],
  );

  const rerun = useCallback(
    async (runId: RunId) => {
      const id = await client.runs.rerun(runId);
      // The fresh run is live from this moment: the list carries the row states
      // a caller renders, so it must not lag behind its own action.
      await refresh();
      return id;
    },
    [client, refresh],
  );

  return {
    automations: data,
    error,
    isLoading,
    refresh,
    enable,
    disable,
    runs: client.runs.list,
    dryRun: client.automations.dryRun,
    stopRun: client.runs.stop,
    rerun,
  };
}

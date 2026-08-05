/** Automation and run transport (08-ui §3, 07-automations §1). */
import type { AppId, RunId } from "@vendoai/core";
import { useCallback } from "react";
import { useVendoContext } from "../context.js";
import { type PollOptions, useResource } from "./use-resource.js";
import type { AutomationEntry, EnableResult, RunPlan, RunRecord, RunStatus } from "../wire-types.js";

export function useAutomations(options?: PollOptions): {
  /** Back-compat alias for `data` (contract §3). */
  automations: AutomationEntry[];
  data: AutomationEntry[];
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
  /** Arm/disarm ONE trigger of an app: an automation is an app with a LIST of
   *  triggers, and each is armed on its own. */
  enable(id: AppId, triggerId: string): Promise<EnableResult>;
  disable(id: AppId, triggerId: string): Promise<void>;
  runs(filter?: {
    appId?: AppId;
    triggerId?: string;
    status?: RunStatus;
    cursor?: string;
  }): Promise<{ runs: RunRecord[]; cursor?: string }>;
  dryRun(id: AppId, triggerId: string): Promise<RunPlan>;
  stopRun(runId: RunId): Promise<void>;
} {
  const { client } = useVendoContext();
  const list = useCallback(() => client.automations.list(), [client]);
  const { data, error, isLoading, refresh } = useResource(list, [] as AutomationEntry[], options);

  const enable = useCallback(
    async (id: AppId, triggerId: string) => {
      const result = await client.automations.enable(id, triggerId);
      await refresh();
      return result;
    },
    [client, refresh],
  );
  const disable = useCallback(
    async (id: AppId, triggerId: string) => {
      await client.automations.disable(id, triggerId);
      await refresh();
    },
    [client, refresh],
  );

  return {
    automations: data,
    data,
    error,
    isLoading,
    refresh,
    enable,
    disable,
    runs: client.runs.list,
    dryRun: client.automations.dryRun,
    stopRun: client.runs.stop,
  };
}

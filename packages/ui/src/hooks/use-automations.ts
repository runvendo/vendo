/** Automation and run transport (08-ui §3, 07-automations §1). */
import type { AppId, RunId } from "@vendoai/core";
import { useCallback, useEffect, useState } from "react";
import { useVendoContext } from "../context.js";
import type { AutomationEntry, EnableResult, RunPlan, RunRecord, RunStatus } from "../wire-types.js";

export function useAutomations(): {
  automations: AutomationEntry[];
  enable(id: AppId): Promise<EnableResult>;
  disable(id: AppId): Promise<void>;
  runs(filter?: { appId?: AppId; status?: RunStatus; cursor?: string }): Promise<{ runs: RunRecord[]; cursor?: string }>;
  dryRun(id: AppId): Promise<RunPlan>;
  stopRun(runId: RunId): Promise<void>;
} {
  const { client } = useVendoContext();
  const [automations, setAutomations] = useState<AutomationEntry[]>([]);
  const refresh = useCallback(async () => setAutomations(await client.automations.list()), [client]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const enable = useCallback(
    async (id: AppId) => {
      const result = await client.automations.enable(id);
      await refresh();
      return result;
    },
    [client, refresh],
  );
  const disable = useCallback(
    async (id: AppId) => {
      await client.automations.disable(id);
      await refresh();
    },
    [client, refresh],
  );

  return {
    automations,
    enable,
    disable,
    runs: client.runs.list,
    dryRun: client.automations.dryRun,
    stopRun: client.runs.stop,
  };
}

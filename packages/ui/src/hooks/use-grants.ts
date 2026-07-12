/** Permission grant transport (08-ui §3). */
import type { GrantId, PermissionGrant } from "@vendoai/core";
import { useCallback, useEffect, useState } from "react";
import { useVendoContext } from "../context.js";

export function useGrants(): { grants: PermissionGrant[]; revoke(id: GrantId): Promise<void> } {
  const { client } = useVendoContext();
  const [grants, setGrants] = useState<PermissionGrant[]>([]);
  const refresh = useCallback(async () => setGrants(await client.grants.list()), [client]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const revoke = useCallback(
    async (id: GrantId) => {
      await client.grants.revoke(id);
      await refresh();
    },
    [client, refresh],
  );

  return { grants, revoke };
}

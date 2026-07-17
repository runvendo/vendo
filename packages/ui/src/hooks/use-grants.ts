/** Permission grant transport (08-ui §3). */
import type { GrantId, PermissionGrant } from "@vendoai/core";
import { useCallback } from "react";
import { useVendoContext } from "../context.js";
import { type PollOptions, useResource } from "./use-resource.js";

export function useGrants(options?: PollOptions): {
  /** Back-compat alias for `data` (contract §3). */
  grants: PermissionGrant[];
  data: PermissionGrant[];
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
  revoke(id: GrantId): Promise<void>;
} {
  const { client } = useVendoContext();
  const list = useCallback(() => client.grants.list(), [client]);
  const { data, error, isLoading, refresh } = useResource(list, [] as PermissionGrant[], options);

  const revoke = useCallback(
    async (id: GrantId) => {
      await client.grants.revoke(id);
      await refresh();
    },
    [client, refresh],
  );

  return { grants: data, data, error, isLoading, refresh, revoke };
}

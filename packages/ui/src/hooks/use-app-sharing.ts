/** The ✦ share toggle's state: which tenant the menu offers, whether the share
 *  is on, and the write. ONE request answers all three (`GET /apps/:id/grants`
 *  carries the caller's own memberships), so the menu never guesses.
 *
 *  Nothing is offered unless there is something to offer: a non-owner may not
 *  share, and a caller in no tenant has nobody to share with. Both answer
 *  `undefined`, and the menu item simply does not render. */
import { encodeGrantPrincipal, type AppId } from "@vendoai/core";
import { useCallback, useEffect, useState } from "react";
import { useVendoProvider } from "../context.js";

export interface AppSharing {
  org: string;
  display: string;
  shared: boolean;
  onToggle(next: boolean): Promise<void>;
}

export function useAppSharing(appId: AppId, enabled = true): AppSharing | undefined {
  const { client } = useVendoProvider();
  const [state, setState] = useState<{ org: string; display: string; shared: boolean }>();

  const read = useCallback(async () => {
    const { level, grants, orgs } = await client.apps.grants(appId);
    // The FIRST tenant, deliberately: a share picker is out of scope, and one
    // toggle that names a tenant beats a menu that lists them.
    const first = orgs[0];
    if (level !== "owner" || first === undefined) return setState(undefined);
    const principal = encodeGrantPrincipal({ kind: "org", org: first.org });
    setState({
      org: first.org,
      display: first.display ?? first.org,
      shared: grants.some((grant) => grant.principal === principal),
    });
  }, [appId, client]);

  useEffect(() => {
    if (!enabled) return;
    // A read failure is not a toggle: the menu keeps its three items.
    void read().catch(() => setState(undefined));
  }, [enabled, read]);

  if (state === undefined) return undefined;
  return {
    ...state,
    onToggle: async (next) => {
      const principal = encodeGrantPrincipal({ kind: "org", org: state.org });
      const { grants } = next
        ? await client.apps.share(appId, principal, "viewer")
        : await client.apps.unshare(appId, principal);
      setState({ ...state, shared: grants.some((grant) => grant.principal === principal) });
    },
  };
}

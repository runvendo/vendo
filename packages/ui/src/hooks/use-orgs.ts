/** Key-gated org workspaces transport (block-actions design §C). */
import { useCallback, useState } from "react";
import { useVendoContext } from "../context.js";
import { type PollOptions, useResource } from "./use-resource.js";
import type { OrgRole, OrgSummary } from "../wire-types.js";

/** The orgs surface degrades honestly: `gated` carries the posture-error
 * message when orgs are unactivated (no VENDO_API_KEY / plan without the
 * `orgs` capability), and the panel renders the upgrade state instead of
 * an error wall. A real (non-gated) failure still lands in `error`. */
export function useOrgs(options?: PollOptions): {
  /** Back-compat alias for `data` (contract §3). */
  orgs: OrgSummary[];
  data: OrgSummary[];
  gated?: string;
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
  create(name: string): Promise<void>;
  addMember(orgId: string, subject: string, role?: OrgRole): Promise<void>;
  setRole(orgId: string, subject: string, role: OrgRole): Promise<void>;
  removeMember(orgId: string, subject: string): Promise<void>;
} {
  const { client } = useVendoContext();
  const [gated, setGated] = useState<string>();

  const list = useCallback(async () => {
    try {
      const result = await client.orgs.list();
      setGated(undefined);
      return result.orgs;
    } catch (reason) {
      const code = (reason as { code?: string }).code;
      if (code === "cloud-required") {
        // A posture verdict, not a failure: surface it via `gated`, keep
        // `error` clear so the panel shows the upgrade state.
        setGated(reason instanceof Error ? reason.message : String(reason));
        return [];
      }
      // A real failure is not a gating verdict — clear any stale `gated` so the
      // panel never shows the upgrade state and an error wall at once.
      setGated(undefined);
      throw reason;
    }
  }, [client]);

  const { data, error, isLoading, refresh } = useResource(list, [] as OrgSummary[], options);

  const create = useCallback(async (name: string) => {
    await client.orgs.create(name);
    await refresh();
  }, [client, refresh]);

  const addMember = useCallback(async (orgId: string, subject: string, role?: OrgRole) => {
    await client.orgs.addMember(orgId, subject, role);
    await refresh();
  }, [client, refresh]);

  const setRole = useCallback(async (orgId: string, subject: string, role: OrgRole) => {
    await client.orgs.setRole(orgId, subject, role);
    await refresh();
  }, [client, refresh]);

  const removeMember = useCallback(async (orgId: string, subject: string) => {
    await client.orgs.removeMember(orgId, subject);
    await refresh();
  }, [client, refresh]);

  return { orgs: data, data, gated, error, isLoading, refresh, create, addMember, setRole, removeMember };
}

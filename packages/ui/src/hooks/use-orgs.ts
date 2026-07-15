/** Key-gated org workspaces transport (block-actions design §C). */
import { useCallback, useEffect, useState } from "react";
import { useVendoContext } from "../context.js";
import type { OrgRole, OrgSummary } from "../wire-types.js";

/** The orgs surface degrades honestly: `gated` carries the posture-error
 * message when orgs are unactivated (no VENDO_API_KEY / plan without the
 * `orgs` capability), and the panel renders the upgrade state instead of
 * an error wall. */
export function useOrgs(): {
  orgs: OrgSummary[];
  gated?: string;
  refresh(): Promise<void>;
  create(name: string): Promise<void>;
  addMember(orgId: string, subject: string, role?: OrgRole): Promise<void>;
  setRole(orgId: string, subject: string, role: OrgRole): Promise<void>;
  removeMember(orgId: string, subject: string): Promise<void>;
} {
  const { client } = useVendoContext();
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [gated, setGated] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const result = await client.orgs.list();
      setOrgs(result.orgs);
      setGated(undefined);
    } catch (reason) {
      const code = (reason as { code?: string }).code;
      if (code === "cloud-required") {
        setOrgs([]);
        setGated(reason instanceof Error ? reason.message : String(reason));
        return;
      }
      throw reason;
    }
  }, [client]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

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

  return { orgs, gated, refresh, create, addMember, setRole, removeMember };
}

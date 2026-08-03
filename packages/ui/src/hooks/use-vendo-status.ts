/** Live guard posture probe (08-ui §3, §6). */
import { useEffect, useState } from "react";
import { useVendoContext } from "../context.js";
import type { Membership } from "@vendoai/core";
import type { GuardPosture } from "../wire-types.js";

interface StatusState {
  posture: GuardPosture;
  connected: boolean;
  /** Build contract §9.1 — the orgs the host asserted for this caller, or []
      when the deployment is single-player. */
  memberships: Membership[];
  /** Build contract §9.1 companion — the host can name a person from a typed
      query (`resolvePerson`). False ⇒ the Share dialog does not offer to share
      with one person at all. */
  namesPeople: boolean;
}

const OFFLINE: StatusState = {
  posture: "unconfigured",
  connected: false,
  memberships: [],
  namesPeople: false,
};

export function useVendoStatus(): StatusState {
  const { client } = useVendoContext();
  const [state, setState] = useState<StatusState>(OFFLINE);

  useEffect(() => {
    let active = true;
    void client
      .status()
      .then(status => {
        if (active) {
          setState({
            posture: status.posture,
            connected: true,
            memberships: status.memberships ?? [],
            namesPeople: status.namesPeople === true,
          });
        }
      })
      .catch(() => {
        if (active) setState(OFFLINE);
      });
    return () => {
      active = false;
    };
  }, [client]);

  return state;
}

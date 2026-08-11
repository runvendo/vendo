/** Live guard posture probe (08-ui §3, §6). */
import { useEffect, useState } from "react";
import { useVendoProvider } from "../context.js";
import type { Membership } from "@vendoai/core";
import type { GuardPosture } from "../wire-types.js";

interface StatusState {
  posture: GuardPosture;
  connected: boolean;
  /** Build contract §9.1 — the orgs the host asserted for this caller, or []
      when the deployment is single-player. */
  memberships: Membership[];
}

const OFFLINE: StatusState = {
  posture: "unconfigured",
  connected: false,
  memberships: [],
};

export function useVendoStatus(): StatusState {
  const { client } = useVendoProvider();
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

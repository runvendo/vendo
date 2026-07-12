/** Live guard posture probe (08-ui §3, §6). */
import { useEffect, useState } from "react";
import { useVendoContext } from "../context.js";
import type { GuardPosture } from "../wire-types.js";

export function useVendoStatus(): { posture: GuardPosture; connected: boolean } {
  const { client } = useVendoContext();
  const [state, setState] = useState<{ posture: GuardPosture; connected: boolean }>({
    posture: "unconfigured",
    connected: false,
  });

  useEffect(() => {
    let active = true;
    void client
      .status()
      .then(status => {
        if (active) setState({ posture: status.posture, connected: true });
      })
      .catch(() => {
        if (active) setState({ posture: "unconfigured", connected: false });
      });
    return () => {
      active = false;
    };
  }, [client]);

  return state;
}

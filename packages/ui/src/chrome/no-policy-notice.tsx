import { useVendoStatus } from "../hooks/use-vendo-status.js";
import { ChromeRoot, useChromeRootPresence } from "./chrome-root.js";
import { PolicyNoticeBody } from "./policy-notice-body.js";

/**
 * 08-ui §6; 05-guard §1 — loud only in the default posture. `connected` gates
 * the render because the hook's initial (and unreachable-wire) state reuses
 * "unconfigured" as its unknown value — the banner asserts a KNOWN posture,
 * never a pending probe.
 */
export function NoPolicyNotice() {
  const { posture, connected } = useVendoStatus();
  const nested = useChromeRootPresence();
  if (!connected || posture !== "unconfigured" || nested) return null;
  return (
    <ChromeRoot automaticPolicyNotice={false}>
      <PolicyNoticeBody />
    </ChromeRoot>
  );
}

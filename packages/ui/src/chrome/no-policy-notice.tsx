import { useVendoStatus } from "../hooks/use-vendo-status.js";
import { ChromeRoot } from "./chrome-root.js";

/**
 * 08-ui §6; 05-guard §1 — loud only in the default posture. `connected` gates
 * the render because the hook's initial (and unreachable-wire) state reuses
 * "unconfigured" as its unknown value — the banner asserts a KNOWN posture,
 * never a pending probe.
 */
export function NoPolicyNotice() {
  const { posture, connected } = useVendoStatus();
  if (!connected || posture !== "unconfigured") return null;
  return (
    <ChromeRoot>
      <section className="vendo-notice" role="region" aria-label="Vendo is running without a policy">
        <strong>Vendo is running without a policy</strong>
        <div>Actions use the default approval posture. Configure <code>.vendo/policy.json</code>.</div>
      </section>
    </ChromeRoot>
  );
}

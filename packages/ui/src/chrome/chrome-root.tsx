import { createContext, useContext, useEffect, type CSSProperties, type ReactNode } from "react";
import { useVendoProvider } from "../context.js";
import { useVendoStatus } from "../hooks/use-vendo-status.js";
import { themeCssVariables } from "../theme.js";
import { PolicyNoticeBody } from "./policy-notice-body.js";
import { ensureThemeFontStyles } from "./theme-fonts.js";

import { CHROME_CSS } from "./chrome-css.js";

/** Inject the chrome stylesheet once. Exported for surfaces that portal OUT of
    a ChromeRoot's DOM subtree (MorphToast, VendoToasts) and hand-roll their own
    `.vendo-root` theme boundary on document.body. */
export function ensureChromeStyles(): void {
  if (typeof document === "undefined" || document.querySelector("style[data-vendo-chrome]")) return;
  const style = document.createElement("style");
  style.dataset.vendoChrome = "";
  style.textContent = CHROME_CSS;
  document.head.append(style);
}

const ChromeRootContext = createContext(false);

export function useChromeRootPresence(): boolean {
  return useContext(ChromeRootContext);
}

/**
 * The "running without a policy" banner is written for the host DEVELOPER (it
 * names a file to configure), so spec §16.3 — the consumer-voice guarantee —
 * keeps it OFF every surface a person reaches.
 *
 * THE DEFECT this default closes: `automaticPolicyNotice` defaulted to TRUE, so
 * the banner auto-prepended itself inside every chrome boundary that didn't
 * think to opt out — the thread, the overlay, the host's pinned slot, a BYO
 * embed, the voice stage. A bank customer read "Vendo is
 * running without a policy · Configure `.vendo/policy.json`" mid-conversation.
 * It is now opt-IN: a developer/console surface asks for it, and any host that
 * wants the banner mounts the exported {@link NoPolicyNotice} itself.
 */
function AutomaticPolicyNotice() {
  const { posture, connected } = useVendoStatus();
  return connected && posture === "unconfigured" ? <PolicyNoticeBody /> : null;
}

function ChromeBoundary({
  children,
  className,
  automaticPolicyNotice,
}: {
  children: ReactNode;
  className?: string;
  automaticPolicyNotice: boolean;
}) {
  const { theme, fonts } = useVendoProvider();
  useEffect(ensureChromeStyles, []);
  useEffect(() => ensureThemeFontStyles(fonts ?? ""), [fonts]);
  return (
    <ChromeRootContext.Provider value>
      <div
        className={["vendo-root", className].filter(Boolean).join(" ")}
        // Decision 4 (spec 2026-08-05): the widget excludes itself from the
        // screen snapshot — every chrome boundary marks its own root.
        data-vendo-ignore=""
        data-vendo-motion={theme.motion}
        data-vendo-density={theme.density}
        style={{ ...themeCssVariables(theme), fontFamily: "var(--vendo-font-family)", fontSize: "var(--vendo-font-size)" } as CSSProperties}
      >
        {automaticPolicyNotice ? <AutomaticPolicyNotice /> : null}
        {children}
      </div>
    </ChromeRootContext.Provider>
  );
}

/** 08-ui §4, §6 — one shared theme/style/notice boundary per chrome surface. */
export function ChromeRoot({
  children,
  className,
  /** Opt IN to the developer policy banner (dev/console surfaces only). */
  automaticPolicyNotice = false,
}: {
  children: ReactNode;
  className?: string;
  automaticPolicyNotice?: boolean;
}) {
  const nested = useChromeRootPresence();
  if (nested) return <>{children}</>;
  return <ChromeBoundary className={className} automaticPolicyNotice={automaticPolicyNotice}>{children}</ChromeBoundary>;
}

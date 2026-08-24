import type { VendoTheme } from "@vendoai/apps/contract";
import { createContext, useContext, useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import { useVendoProvider } from "../context.js";
import { useVendoStatus } from "../hooks/use-vendo-status.js";
import { resolveTheme, themeCssVariables } from "../theme.js";
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

/** The theme the enclosing chrome boundary resolved, or null outside one. It
    carries the VALUE rather than a bare presence flag so that a surface which
    portals OUT of the boundary's DOM subtree can still read the theme of the
    surface that spawned it (see {@link useChromeTheme}). */
const ChromeRootContext = createContext<VendoTheme | null>(null);

export function useChromeRootPresence(): boolean {
  return useContext(ChromeRootContext) !== null;
}

/**
 * The theme in force at this point in the REACT tree: the nearest chrome
 * boundary's resolved theme, else the provider's.
 *
 * This is what anything portalling to `document.body` reads. Those surfaces
 * hand-roll their own `.vendo-root` boundary (the comment above
 * {@link ensureChromeStyles}), so a DOM-cascade inheritance never reaches
 * them — but they are still rendered from inside their spawning surface's
 * React subtree, and that surface may carry its own `theme`.
 */
export function useChromeTheme(): VendoTheme {
  const boundary = useContext(ChromeRootContext);
  const provider = useVendoProvider().theme;
  return boundary ?? provider;
}

/** A surface's own partial theme, merged over the provider's resolved theme —
    the same merge `VendoProvider` applies over `defaultVendoTheme`. With no
    provider above, the provider value IS `defaultVendoTheme`, so a bare surface
    merges over the defaults. */
export function useSurfaceTheme(theme?: Partial<VendoTheme>): VendoTheme {
  const provider = useVendoProvider().theme;
  return useMemo(() => resolveTheme(provider, theme), [provider, theme]);
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
  theme: override,
  automaticPolicyNotice,
}: {
  children: ReactNode;
  className?: string;
  theme?: Partial<VendoTheme>;
  automaticPolicyNotice: boolean;
}) {
  const { fonts } = useVendoProvider();
  const theme = useSurfaceTheme(override);
  useEffect(ensureChromeStyles, []);
  useEffect(() => ensureThemeFontStyles(fonts ?? ""), [fonts]);
  return (
    <ChromeRootContext.Provider value={theme}>
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
  /** This surface's own brand tokens, merged over the provider's. */
  theme,
  /** Opt IN to the developer policy banner (dev/console surfaces only). */
  automaticPolicyNotice = false,
}: {
  children: ReactNode;
  className?: string;
  theme?: Partial<VendoTheme>;
  automaticPolicyNotice?: boolean;
}) {
  const nested = useChromeRootPresence();
  // A nested boundary is redundant — the ancestor already emitted these exact
  // tokens — UNLESS this surface carries a theme of its own, which the
  // pass-through would silently drop. Then the inner boundary restates the
  // merged tokens and the cascade does the rest.
  if (nested && theme === undefined) return <>{children}</>;
  return <ChromeBoundary className={className} theme={theme} automaticPolicyNotice={automaticPolicyNotice}>{children}</ChromeBoundary>;
}

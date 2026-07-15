import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVendoTheme } from "../context.js";
import { themeCssVariables } from "../theme.js";

/**
 * ENG-228 — while the mobile takeover is active, the surface escapes to
 * document.body. `position: fixed` alone cannot deliver the designed
 * "host layout is covered" promise: any transformed/filtered host ancestor
 * (page-transition animations, typically) becomes the containing block and
 * confines the takeover to the host column. Same escape hatch as
 * VendoOverlay's portal; the display:contents wrapper carries the
 * .vendo-root token bridge so the surface stays brand-themed outside the
 * host ChromeRoot. Inactive (desktop) rendering is untouched and in-tree.
 */
export function TakeoverPortal({ active, children }: { active: boolean; children: ReactNode }) {
  const theme = useVendoTheme();
  if (!active || typeof document === "undefined") return <>{children}</>;
  return createPortal(
    <div
      className="vendo-root fl-overlay-portal"
      data-vendo-motion={theme.motion}
      data-vendo-density={theme.density}
      style={{ ...themeCssVariables(theme), fontFamily: "var(--vendo-font-family)", fontSize: "var(--vendo-font-size)" } as CSSProperties}
    >
      {children}
    </div>,
    document.body,
  );
}

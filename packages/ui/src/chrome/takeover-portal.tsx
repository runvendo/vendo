import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVendoTheme } from "../context.js";
import { themeCssVariables } from "../theme.js";
import { inertBehind } from "./inert-behind.js";

/**
 * ENG-228 — while the mobile takeover is active, the surface escapes to
 * document.body. `position: fixed` alone cannot deliver the designed
 * "host layout is covered" promise: any transformed/filtered host ancestor
 * (page-transition animations, typically) becomes the containing block and
 * confines the takeover to the host column. Same escape hatch as
 * VendoOverlay's portal; the display:contents wrapper carries the
 * .vendo-root token bridge so the surface stays brand-themed outside the
 * host ChromeRoot. Inactive (desktop) rendering is untouched and in-tree.
 *
 * While it is up, the host page it covers is INERT. Covering the viewport with
 * a fixed surface only stops the mouse: without this the host's own navigation
 * stayed in the tab order and in the accessibility tree behind a page the user
 * cannot see — the same promise the overlay panel already keeps.
 */
export function TakeoverPortal({ active, children }: { active: boolean; children: ReactNode }) {
  const theme = useVendoTheme();
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    return inertBehind(wrapper.current);
  }, [active]);
  if (!active || typeof document === "undefined") return <>{children}</>;
  return createPortal(
    <div
      ref={wrapper}
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

/**
 * The chrome overlay host — the one body-level surface a Kit overlay paints on.
 *
 * A Modal drawn in place is trapped by whatever the screen is sitting in: a
 * containment box, a transformed ancestor, an `overflow: hidden` column. So it
 * portals to `document.body` inside its own `.vendo-root`, which is the same
 * move `VendoToasts` makes and for the same reason — the boundary carries the
 * theme, so a surface that escaped every themed ancestor is still brand-native.
 *
 * `createPortal` and not a second React root: the tree stays UNBROKEN, so the
 * app context, the keyed `$state` store and a handler bound by the renderer all
 * reach an overlay exactly as they reach a brick painted in place.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ensureChromeStyles } from "../chrome/chrome-root.js";
import { useVendoThemeOrDefault } from "../context.js";
import { ensureKitStyles } from "../kit/kit-css.js";
import { themeCssVariables } from "../theme.js";

/**
 * `children` is a function of the host element, because Base UI refuses to
 * render a popup outside its own `<Dialog.Portal>` and that portal has to be
 * pointed AT this boundary — otherwise it hops to `<body>` on its own and the
 * popup lands outside the theme scope this element exists to draw.
 */
export function OverlayPortal({ children }: { children: (host: HTMLElement | null) => ReactNode }): ReactNode {
  const theme = useVendoThemeOrDefault();
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    ensureChromeStyles();
    ensureKitStyles();
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={setHost}
      className="vendo-root"
      data-vendo-ignore=""
      // Marks it as a Vendo surface that is never behind: `inertBehind` exempts
      // `[data-vendo-portal]`, so an overlay raised while the agent panel is
      // open stays clickable instead of being inerted with the host's page.
      data-vendo-portal="kit-overlay"
      data-vendo-motion={theme.motion}
      data-vendo-density={theme.density}
      style={themeCssVariables(theme) as CSSProperties}
    >
      {children(host)}
    </div>,
    document.body,
  );
}

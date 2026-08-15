/** Sheet — the same dialog pinned to an edge, for detail that sits beside the
 *  screen rather than on top of it. */
import type { CSSProperties } from "react";
import { DialogShell, EXTENT, type DialogProps, type OverlaySize } from "./dialog.js";

export type SheetSide = "left" | "right" | "top" | "bottom";

export interface SheetProps extends DialogProps {
  side?: SheetSide;
}

/** Where the panel sits, and which way `size` measures it: an edge sheet fills
 *  the two sides it is pinned to and takes its extent from the third. */
const geometry = (side: SheetSide, extent: number): CSSProperties => {
  const depth = `min(${extent}px, calc(100% - 32px))`;
  if (side === "left" || side === "right") {
    return { top: 0, bottom: 0, [side]: 0, width: depth };
  }
  return { left: 0, right: 0, [side]: 0, height: depth };
};

export function Sheet({ side = "right", size = "medium", ...rest }: SheetProps) {
  return (
    <DialogShell
      kind="Sheet"
      popupStyle={{ ...geometry(side, EXTENT[size as OverlaySize] ?? EXTENT.medium), borderRadius: 0 }}
      {...rest}
    />
  );
}

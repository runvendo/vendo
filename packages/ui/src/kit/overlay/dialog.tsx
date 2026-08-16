/**
 * The shell Modal and Sheet share. They are one component with two geometries —
 * a centered card and an edge that slides — so the chrome (title, description,
 * the close affordance, the header/footer slots) is written once and the only
 * thing either passes down is where its popup sits.
 *
 * Base UI's Dialog supplies the three behaviors that are miserable by hand and
 * invisible when wrong: the focus trap, Esc, and the page's scroll lock.
 */
import { Dialog } from "@base-ui/react/dialog";
import type { CSSProperties, ReactNode } from "react";
import { OverlayPortal } from "../../tree/overlay-portal.js";
import { font, hairline, t, transitionFor } from "../tokens.js";

export type OverlaySize = "small" | "medium" | "large";

/**
 * Shared by both geometries — Sheet adds `side` on top.
 *
 * `open` and `onClose` are BOTH required, and that is the type doing the same
 * job the spec does for generated screens: every way out of a dialog — the X,
 * Esc, the backdrop — does nothing but call `onClose`, so `<Modal open />`
 * without one is a person shut behind a dialog that cannot be dismissed. It
 * must not compile.
 *
 * Not a discriminated union, because there is no uncontrolled dialog to be the
 * union's other arm: `Dialog.Root` is always handed `open`, and this takes no
 * trigger and no `defaultOpen`. A union would model a mode that does not exist
 * — requiring both is the smaller shape that makes the same call unrepresentable.
 */
export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  size?: OverlaySize;
  /** Elements along the top edge, beside the title. */
  header?: ReactNode;
  /** The buttons under the content. */
  footer?: ReactNode;
  children?: ReactNode;
}

/** The one measure both geometries read: a Modal's width, a Sheet's depth. */
export const EXTENT: Record<OverlaySize, number> = { small: 360, medium: 480, large: 720 };

/** The dismiss affordance every overlay carries, dialog and toast alike. */
export const closeStyle: CSSProperties = {
  ...font,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  flexShrink: 0,
  border: `${t.borderWidth} solid transparent`,
  borderRadius: t.radiusSmall,
  color: t.muted,
  background: "transparent",
  cursor: "pointer",
  fontSize: "1.1em",
  lineHeight: 1,
  transition: transitionFor("background-color", "color"),
};

export function DialogShell({
  kind,
  popupStyle,
  open,
  onClose,
  title,
  description,
  header,
  footer,
  children,
}: DialogProps & { kind: "Modal" | "Sheet"; popupStyle: CSSProperties }) {
  const body = (
    <>
      {/* Always drawn: `onClose` is required, so there is always a way out to
          draw, even on a dialog with no title and no header. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--vendo-density-inline-gap, 7px)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
          {title === undefined ? null : (
            <Dialog.Title
              style={{
                margin: 0,
                color: t.text,
                fontFamily: t.headingFamily,
                fontSize: "1.05em",
                fontWeight: t.weightEmphasis,
                lineHeight: t.lineHeightHeading,
              }}
            >
              {title}
            </Dialog.Title>
          )}
          {description === undefined ? null : (
            <Dialog.Description style={{ margin: 0, color: t.muted, fontSize: "0.9em" }}>
              {description}
            </Dialog.Description>
          )}
        </div>
        {header}
        {/* Rendered INSIDE the popup on purpose: with the focus trap on, a
            touch screen reader has no other way out. */}
        <Dialog.Close data-kit-close="" aria-label="Close" style={closeStyle}>
          ✕
        </Dialog.Close>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{children}</div>
      {footer === undefined ? null : (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--vendo-density-inline-gap, 7px)" }}>
          {footer}
        </div>
      )}
    </>
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <OverlayPortal>
        {(host) => host === null ? null : (
          <Dialog.Portal container={host}>
            <Dialog.Backdrop
              style={{
                position: "fixed",
                inset: 0,
                // Dimmed against `text`, never a literal black: on a dark host
                // theme a black scrim is invisible and the page never recedes.
                background: `color-mix(in srgb, ${t.text} 32%, transparent)`,
              }}
            />
            <Dialog.Popup
              data-kit={kind}
              style={{
                ...font,
                position: "fixed",
                display: "flex",
                flexDirection: "column",
                gap: "var(--vendo-density-content-gap, 10px)",
                boxSizing: "border-box",
                border: hairline,
                background: t.surface,
                boxShadow: t.shadowSmall,
                padding: "var(--vendo-density-card-padding, 16px)",
                ...popupStyle,
              }}
            >
              {body}
            </Dialog.Popup>
          </Dialog.Portal>
        )}
      </OverlayPortal>
    </Dialog.Root>
  );
}

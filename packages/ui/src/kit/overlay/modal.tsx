/** Modal — a dialog centered over the screen, for a decision that has to be
 *  answered before anything else. */
import { DialogShell, EXTENT, type DialogProps } from "./dialog.js";
import { t } from "../tokens.js";

export type ModalProps = DialogProps;

export function Modal({ size = "medium", ...rest }: ModalProps) {
  return (
    <DialogShell
      kind="Modal"
      popupStyle={{
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: `min(${EXTENT[size] ?? EXTENT.medium}px, calc(100vw - 32px))`,
        maxHeight: "calc(100vh - 64px)",
        borderRadius: t.radiusLarge,
      }}
      {...rest}
    />
  );
}

/** Checkbox — boolean input; onChange reports checked (W2 §The Kit). */
import type { ComponentProps } from "react";
import { t, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";

interface CheckboxOwnProps extends KitStyled {
  label?: string;
  checked?: boolean;
  /** Neither on nor off — the "some of these" box over a partly-ticked list. */
  indeterminate?: boolean;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  onChange?: (checked: boolean) => void;
}

/** Plus any `<input>` attribute, handed straight to the box — `type` excepted,
 *  which is the Kit's own. `style` stays the Kit's too: it dresses the ROOT the
 *  label and hint share. */
export type CheckboxProps = CheckboxOwnProps & KitEngine<ComponentProps<"input">, CheckboxOwnProps, "type">;

export function Checkbox({ label, checked, indeterminate, hint, disabled, required, onChange, style, children, pending, ...engine }: CheckboxProps & KitRendered) {
  const { fieldId, helpId } = useFieldIds("checkbox");
  const screen = controlledHandler(checked !== undefined, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} inline style={style}>
      <input
        data-kit="Checkbox"
        disabled={disabled}
        required={required}
        aria-describedby={hint ? helpId : undefined}
        {...given(engine)}
        // AFTER the passthrough, with the id and the value: `type` is what makes
        // this control a checkbox at all. The compiler omits it from the
        // passthrough, but the wire lets an engine's props through by NAME, so
        // the guard has to hold at render too.
        type="checkbox"
        // The third state is a DOM property with no React attribute behind it, so
        // it is stated on the node — after every render, because a click clears it
        // in the browser and only the prop puts it back. It touches nothing the
        // controlled/uncontrolled decision above owns: `indeterminate` and
        // `checked` are separate properties and neither overwrites the other.
        ref={(node) => {
          if (node !== null) node.indeterminate = indeterminate === true;
        }}
        id={fieldId}
        {...(screen === null ? { defaultChecked: checked } : { checked: checked ?? false })}
        onChange={(e) => screen === null
          ? onChange?.(e.target.checked)
          : screen({ target: { checked: e.target.checked } })}
        style={{ width: 16, height: 16, accentColor: t.accent, cursor: disabled ? "not-allowed" : "pointer" }}
      />
    </FieldShell>
  );
}

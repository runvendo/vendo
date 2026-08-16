/** Checkbox — boolean input; onChange reports checked (W2 §The Kit). */
import { t, type KitStyled } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";

export interface CheckboxProps extends KitStyled {
  label?: string;
  checked?: boolean;
  hint?: string;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}

export function Checkbox({ label, checked, hint, disabled, onChange, style }: CheckboxProps) {
  const { fieldId, helpId } = useFieldIds("checkbox");
  const screen = controlledHandler(checked !== undefined, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} inline style={style}>
      <input
        id={fieldId}
        data-kit="Checkbox"
        type="checkbox"
        {...(screen === null ? { defaultChecked: checked } : { checked: checked ?? false })}
        disabled={disabled}
        aria-describedby={hint ? helpId : undefined}
        onChange={(e) => screen === null
          ? onChange?.(e.target.checked)
          : screen({ target: { checked: e.target.checked } })}
        style={{ width: 16, height: 16, accentColor: t.accent, cursor: disabled ? "not-allowed" : "pointer" }}
      />
    </FieldShell>
  );
}

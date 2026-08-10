/** Checkbox — boolean input; onChange reports checked (W2 §The Kit). */
import { t } from "../tokens.js";
import { FieldShell, useFieldIds } from "./field.js";

export interface CheckboxProps {
  label?: string;
  /** Field name — what this value is called in the submit args of an enclosing Form. */
  name?: string;
  checked?: boolean;
  hint?: string;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}

export function Checkbox({ label, name, checked, hint, disabled, onChange }: CheckboxProps) {
  const { fieldId, helpId } = useFieldIds("checkbox");
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} inline>
      <input
        id={fieldId}
        data-kit="Checkbox"
        name={name}
        type="checkbox"
        defaultChecked={checked}
        disabled={disabled}
        aria-describedby={hint ? helpId : undefined}
        onChange={(e) => onChange?.(e.target.checked)}
        style={{ width: 17, height: 17, accentColor: t.accent, cursor: disabled ? "not-allowed" : "pointer" }}
      />
    </FieldShell>
  );
}

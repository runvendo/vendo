/** DatePicker — themed native date control (W2 §The Kit). */
import { control } from "../tokens.js";
import { FieldShell, useFieldIds } from "./field.js";

export interface DatePickerProps {
  label?: string;
  /** ISO yyyy-mm-dd. */
  value?: string;
  min?: string;
  max?: string;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  onChange?: (value: string) => void;
}

export function DatePicker({ label, value, min, max, hint, disabled, required, onChange }: DatePickerProps) {
  const { fieldId, helpId } = useFieldIds("date");
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint}>
      <input
        id={fieldId}
        data-kit="DatePicker"
        type="date"
        defaultValue={value}
        min={min}
        max={max}
        disabled={disabled}
        required={required}
        aria-describedby={hint ? helpId : undefined}
        onChange={(e) => onChange?.(e.target.value)}
        style={{ ...control, opacity: disabled ? 0.55 : 1 }}
      />
    </FieldShell>
  );
}

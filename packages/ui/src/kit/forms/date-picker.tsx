/** DatePicker — themed native date control (W2 §The Kit). */
import { Input as Base } from "@base-ui/react/input";
import { control } from "../tokens.js";
import { controlledHandler } from "../handler.js";
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
  const screen = controlledHandler(value !== undefined, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint}>
      {/* The same Base UI Input the text field uses — one date, natively. Two
          dates from one calendar is DateRange. */}
      <Base
        id={fieldId}
        data-kit="DatePicker"
        type="date"
        {...(screen === null ? { defaultValue: value } : { value: value ?? "" })}
        min={min}
        max={max}
        disabled={disabled}
        required={required}
        aria-describedby={hint ? helpId : undefined}
        onValueChange={(next) => screen === null
          ? onChange?.(next)
          : screen({ target: { value: next } })}
        style={{ ...control, opacity: disabled ? 0.55 : 1 }}
      />
    </FieldShell>
  );
}

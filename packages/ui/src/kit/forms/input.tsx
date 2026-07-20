/** Input — themed text field; onChange reports the value (W2 §The Kit). */
import { control, t } from "../tokens.js";
import { FieldShell, useFieldIds } from "./field.js";

export interface InputProps {
  label?: string;
  value?: string;
  placeholder?: string;
  type?: "text" | "email" | "number" | "password" | "search" | "tel" | "url";
  hint?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  /** Bound change handler; receives the new value. */
  onChange?: (value: string) => void;
}

export function Input({ label, value, placeholder, type = "text", hint, error, disabled, required, onChange }: InputProps) {
  const { fieldId, helpId } = useFieldIds("input");
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} error={error}>
      <input
        id={fieldId}
        data-kit="Input"
        type={type}
        defaultValue={value}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? helpId : undefined}
        onChange={(e) => onChange?.(e.target.value)}
        style={{ ...control, borderColor: error ? t.danger : t.border, opacity: disabled ? 0.55 : 1 }}
      />
    </FieldShell>
  );
}

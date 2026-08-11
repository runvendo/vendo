/** Textarea — themed multiline input (W2 §The Kit). */
import { control } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";

export interface TextareaProps {
  label?: string;
  value?: string;
  placeholder?: string;
  rows?: number;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  onChange?: (value: string) => void;
}

export function Textarea({ label, value, placeholder, rows = 3, hint, disabled, required, onChange }: TextareaProps) {
  const { fieldId, helpId } = useFieldIds("textarea");
  const screen = controlledHandler(value !== undefined, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint}>
      <textarea
        id={fieldId}
        data-kit="Textarea"
        {...(screen === null ? { defaultValue: value } : { value: value ?? "" })}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        required={required}
        aria-describedby={hint ? helpId : undefined}
        onChange={(e) => screen === null
          ? onChange?.(e.target.value)
          : screen({ target: { value: e.target.value } })}
        style={{ ...control, resize: "vertical", minHeight: undefined, opacity: disabled ? 0.55 : 1 }}
      />
    </FieldShell>
  );
}

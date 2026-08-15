/** Input — themed text field; onChange reports the value (W2 §The Kit). */
import { Input as Base } from "@base-ui/react/input";
import { control, t } from "../tokens.js";
import { controlledHandler } from "../handler.js";
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
  // A screen owns its value (kit/handler.ts): controlled, and the change reaches
  // the screen's handler as the event its source was written against.
  const screen = controlledHandler(value !== undefined, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} error={error}>
      {/* Base UI's Input is a real `<input>` that registers itself with a Form,
          so a submit can validate it and focus the first field that failed. */}
      <Base
        id={fieldId}
        data-kit="Input"
        type={type}
        {...(screen === null ? { defaultValue: value } : { value: value ?? "" })}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? helpId : undefined}
        onValueChange={(next) => screen === null
          ? onChange?.(next)
          : screen({ target: { value: next } })}
        style={{ ...control, borderColor: error ? t.danger : t.border, opacity: disabled ? 0.55 : 1 }}
      />
    </FieldShell>
  );
}

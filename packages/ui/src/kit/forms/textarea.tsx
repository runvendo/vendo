/** Textarea — themed multiline input (W2 §The Kit). */
import { control } from "../tokens.js";
import { FieldShell, useFieldIds } from "./field.js";

export interface TextareaProps {
  label?: string;
  /** The submit tool ARGUMENT this field fills; `<Form>` reads it by this
   *  name. A field without one sends nothing. */
  name?: string;
  value?: string;
  placeholder?: string;
  rows?: number;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  onChange?: (value: string) => void;
}

export function Textarea({ label, name, value, placeholder, rows = 3, hint, disabled, required, onChange }: TextareaProps) {
  const { fieldId, helpId } = useFieldIds("textarea");
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint}>
      <textarea
        id={fieldId}
        data-kit="Textarea"
        name={name}
        defaultValue={value}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        required={required}
        aria-describedby={hint ? helpId : undefined}
        onChange={(e) => onChange?.(e.target.value)}
        style={{ ...control, resize: "vertical", minHeight: undefined, opacity: disabled ? 0.55 : 1 }}
      />
    </FieldShell>
  );
}

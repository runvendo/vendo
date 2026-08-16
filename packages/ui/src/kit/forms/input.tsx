/** Input — themed text field; onChange reports the value (W2 §The Kit). */
import { Input as Base } from "@base-ui/react/input";
import type { ReactNode } from "react";
import { control, t } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";

export interface InputProps {
  label?: string;
  value?: string;
  placeholder?: string;
  type?: "text" | "email" | "number" | "password" | "search" | "tel" | "url";
  hint?: ReactNode;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  /** A Kit mark inside the field, before the text — a currency glyph, a unit. */
  prefix?: ReactNode;
  /** A Kit mark inside the field, after the text. */
  suffix?: ReactNode;
  /** Bound change handler; receives the new value. */
  onChange?: (value: string) => void;
}

export function Input({ label, value, placeholder, type = "text", hint, error, disabled, required, prefix, suffix, onChange }: InputProps) {
  const { fieldId, helpId } = useFieldIds("input");
  // A screen owns its value (kit/handler.ts): controlled, and the change reaches
  // the screen's handler as the event its source was written against.
  const screen = controlledHandler(value !== undefined, onChange);
  // With an affix the BOX moves out to the row that carries it, and the field
  // goes bare inside — an affix in a border of its own would read as two
  // controls where the person sees one.
  const affixed = prefix !== undefined || suffix !== undefined;
  const field = (
    // Base UI's Input is a real `<input>` that registers itself with a Form, so
    // a submit can validate it and focus the first field that failed.
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
      style={{
        ...control,
        ...(affixed
          ? { border: 0, background: "transparent", padding: 0 }
          : { borderColor: error ? t.danger : t.border }),
        opacity: disabled ? 0.55 : 1,
      }}
    />
  );
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} error={error}>
      {affixed ? (
        <span
          data-kit-affix=""
          style={{
            ...control,
            display: "flex",
            alignItems: "center",
            gap: "var(--vendo-density-field-gap, 6px)",
            borderColor: error ? t.danger : t.border,
            color: t.muted,
            opacity: disabled ? 0.55 : 1,
          }}
        >
          {prefix}
          {field}
          {suffix}
        </span>
      ) : field}
    </FieldShell>
  );
}

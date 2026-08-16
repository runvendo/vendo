/** Textarea — themed multiline input (W2 §The Kit). */
import type { ReactNode } from "react";
import { control, t, type KitStyled } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";

export interface TextareaProps extends KitStyled {
  label?: string;
  value?: string;
  placeholder?: string;
  rows?: number;
  hint?: ReactNode;
  disabled?: boolean;
  required?: boolean;
  /** Kit elements in a row under the box — a counter, a hint action. */
  footer?: ReactNode;
  onChange?: (value: string) => void;
}

export function Textarea({ label, value, placeholder, rows = 3, hint, disabled, required, footer, onChange, style }: TextareaProps) {
  const { fieldId, helpId } = useFieldIds("textarea");
  const screen = controlledHandler(value !== undefined, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} style={style}>
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
      {footer === undefined ? null : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: "var(--vendo-density-inline-gap, 7px)",
            color: t.muted,
            fontSize: "0.82em",
          }}
        >
          {footer}
        </div>
      )}
    </FieldShell>
  );
}

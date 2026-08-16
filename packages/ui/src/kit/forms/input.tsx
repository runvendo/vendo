/** Input — themed text field; onChange reports the value (W2 §The Kit). */
import { Input as Base } from "@base-ui/react/input";
import type { ComponentProps, ReactNode } from "react";
import { control, t, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";

interface InputOwnProps extends KitStyled {
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

/** Plus any Base UI `<Input>` prop, handed straight to the field. `style` stays
 *  the Kit's own — it dresses the ROOT the label and hint share, not the box. */
export type InputProps = InputOwnProps & KitEngine<ComponentProps<typeof Base>, InputOwnProps>;

export function Input({ label, value, placeholder, type = "text", hint, error, disabled, required, prefix, suffix, onChange, style, children, pending, ...engine }: InputProps & KitRendered) {
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
      data-kit="Input"
      type={type}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      aria-invalid={error ? true : undefined}
      aria-describedby={error || hint ? helpId : undefined}
      {...given(engine)}
      id={fieldId}
      {...(screen === null ? { defaultValue: value } : { value: value ?? "" })}
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
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} error={error} style={style}>
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

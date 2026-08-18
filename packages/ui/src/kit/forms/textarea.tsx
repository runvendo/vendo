/** Textarea — themed multiline input (W2 §The Kit). */
import type { ComponentProps, ReactNode } from "react";
import { control, t, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";

interface TextareaOwnProps extends KitStyled {
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

/** Plus any `<textarea>` attribute, handed straight to the box. `style` stays
 *  the Kit's own — it dresses the ROOT the label and hint share, not the box. */
export type TextareaProps = TextareaOwnProps & KitEngine<ComponentProps<"textarea">, TextareaOwnProps>;

export function Textarea({ label, value, placeholder, rows = 3, hint, disabled, required, footer, onChange, style, children, pending, ...engine }: TextareaProps & KitRendered) {
  const { fieldId, helpId } = useFieldIds("textarea");
  const screen = controlledHandler(value !== undefined, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} style={style}>
      <textarea
        data-kit="Textarea"
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        required={required}
        aria-describedby={hint ? helpId : undefined}
        {...given(engine)}
        id={fieldId}
        {...(screen === null ? { defaultValue: value } : { value: value ?? "" })}
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

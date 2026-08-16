/** DatePicker — themed native date control (W2 §The Kit). */
import { Input as Base } from "@base-ui/react/input";
import type { ComponentProps, ReactNode } from "react";
import { control, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";

interface DatePickerOwnProps extends KitStyled {
  label?: string;
  /** ISO yyyy-mm-dd. */
  value?: string;
  min?: string;
  max?: string;
  hint?: ReactNode;
  disabled?: boolean;
  required?: boolean;
  onChange?: (value: string) => void;
}

/** Plus any Base UI `<Input>` prop, handed straight to the field. `style` stays
 *  the Kit's own — it dresses the ROOT the label and hint share, not the box. */
export type DatePickerProps = DatePickerOwnProps & KitEngine<ComponentProps<typeof Base>, DatePickerOwnProps>;

export function DatePicker({ label, value, min, max, hint, disabled, required, onChange, style, children, pending, ...engine }: DatePickerProps & KitRendered) {
  const { fieldId, helpId } = useFieldIds("date");
  const screen = controlledHandler(value !== undefined, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} style={style}>
      {/* The same Base UI Input the text field uses — one date, natively. Two
          dates from one calendar is DateRange. */}
      <Base
        data-kit="DatePicker"
        type="date"
        min={min}
        max={max}
        disabled={disabled}
        required={required}
        aria-describedby={hint ? helpId : undefined}
        {...given(engine)}
        id={fieldId}
        {...(screen === null ? { defaultValue: value } : { value: value ?? "" })}
        onValueChange={(next) => screen === null
          ? onChange?.(next)
          : screen({ target: { value: next } })}
        style={{ ...control, opacity: disabled ? 0.55 : 1 }}
      />
    </FieldShell>
  );
}

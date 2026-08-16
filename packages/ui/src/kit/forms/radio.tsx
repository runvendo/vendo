/**
 * Radio — one choice out of a few, all of them visible (W2 §The Kit).
 * Takes RAW tool output through labelField/valueField, exactly as Select does.
 */
import { Radio as Base } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { ComponentProps } from "react";
import { font, hairline, t, transitionFor, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";
import { choices, type KitOption } from "./options.js";

interface RadioOwnProps extends KitStyled {
  label?: string;
  /** Raw items — primitives or objects. */
  options: KitOption[];
  labelField?: string;
  valueField?: string;
  value?: string;
  hint?: string;
  disabled?: boolean;
  /** Bound change handler; receives the selected value. */
  onChange?: (value: string) => void;
}

/** Plus any Base UI `<RadioGroup>` prop, handed straight to the group. `style`
 *  stays the Kit's own — it dresses the ROOT the label and hint share. */
export type RadioProps = RadioOwnProps & KitEngine<ComponentProps<typeof RadioGroup>, RadioOwnProps>;

export function Radio({ label, options: rawOptions, labelField, valueField, value, hint, disabled, onChange, style, children, pending, ...engine }: RadioProps & KitRendered) {
  const { fieldId, helpId } = useFieldIds("radio");
  const options = choices(rawOptions, labelField, valueField);
  const screen = controlledHandler(value !== undefined, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} style={style}>
      <RadioGroup
        data-kit="Radio"
        disabled={disabled}
        aria-describedby={hint ? helpId : undefined}
        {...given(engine)}
        {...(screen === null ? { defaultValue: value } : { value: value ?? "" })}
        onValueChange={(next) => screen === null
          ? onChange?.(String(next))
          : screen({ target: { value: String(next) } })}
        style={{ ...font, display: "flex", flexDirection: "column", gap: "var(--vendo-density-field-gap, 6px)" }}
      >
        {options.map((option, i) => (
          // Positional ids, not the value's own text: a value is arbitrary tool
          // output and an id may not carry whitespace.
          <label
            key={`${option.value}-${i}`}
            htmlFor={`${fieldId}-${i}`}
            style={{ display: "flex", alignItems: "center", gap: "var(--vendo-density-inline-gap, 7px)", cursor: disabled ? "not-allowed" : "pointer" }}
          >
            <Base.Root
              id={`${fieldId}-${i}`}
              value={option.value}
              // Named by its OWN option, not by the field. The surrounding
              // Field.Root offers every control the field's label, which would
              // make all four radios answer to "Client".
              aria-labelledby={`${fieldId}-${i}-label`}
              style={({ checked }) => ({
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 16,
                height: 16,
                border: checked ? `${t.borderWidth} solid ${t.accent}` : hairline,
                borderRadius: "50%",
                background: t.surface,
                transition: transitionFor("border-color"),
              })}
            >
              <Base.Indicator style={{ width: 8, height: 8, borderRadius: "50%", background: t.accent }} />
            </Base.Root>
            <span id={`${fieldId}-${i}-label`}>{option.label}</span>
          </label>
        ))}
      </RadioGroup>
    </FieldShell>
  );
}

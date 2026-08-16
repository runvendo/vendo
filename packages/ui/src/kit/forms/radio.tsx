/**
 * Radio — one choice out of a few, all of them visible (W2 §The Kit).
 * Takes RAW tool output through labelField/valueField, exactly as Select does.
 */
import { Radio as Base } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { font, hairline, t, transitionFor } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";
import { choices, type KitOption } from "./options.js";

export interface RadioProps {
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

export function Radio({ label, options: rawOptions, labelField, valueField, value, hint, disabled, onChange }: RadioProps) {
  const { fieldId, helpId } = useFieldIds("radio");
  const options = choices(rawOptions, labelField, valueField);
  const screen = controlledHandler(value !== undefined, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint}>
      <RadioGroup
        data-kit="Radio"
        {...(screen === null ? { defaultValue: value } : { value: value ?? "" })}
        disabled={disabled}
        aria-describedby={hint ? helpId : undefined}
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

/**
 * Select — over RAW object arrays via labelField/valueField (W2 §The Kit).
 * The model passes tool output straight in; no `asOptions` reshape needed.
 * `multiple` folds in MultiSelect.
 */
import { control } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";
import { choices, type KitOption } from "./options.js";

export type SelectOption = KitOption;

export interface SelectProps {
  label?: string;
  /** Raw items — primitives or objects. */
  options: SelectOption[];
  /** Object field for the visible label (defaults to the item itself). */
  labelField?: string;
  /** Object field for the value (defaults to the item itself). */
  valueField?: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  /** Allow selecting several values. */
  multiple?: boolean;
  /** Bound change handler; receives the selected value(s). */
  onChange?: (value: string | string[]) => void;
}

export function Select({ label, options: rawOptions, labelField, valueField, value, placeholder, hint, disabled, required, multiple, onChange }: SelectProps) {
  const { fieldId, helpId } = useFieldIds("select");
  const options = choices(rawOptions, labelField, valueField);
  // Single choice only: `value` is one string, and a controlled `multiple` select
  // needs a list, so a multi-select on a screen keeps the uncontrolled DOM.
  const screen = controlledHandler(value !== undefined && multiple !== true, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint}>
      <select
        id={fieldId}
        data-kit="Select"
        multiple={multiple}
        {...(screen === null ? { defaultValue: value } : { value: value ?? "" })}
        disabled={disabled}
        required={required}
        aria-describedby={hint ? helpId : undefined}
        onChange={(e) => {
          if (screen !== null) {
            screen({ target: { value: e.target.value } });
          } else if (multiple) {
            onChange?.(Array.from(e.target.selectedOptions, (o) => o.value));
          } else {
            onChange?.(e.target.value);
          }
        }}
        style={{ ...control, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 }}
      >
        {placeholder !== undefined && !multiple ? <option value="">{placeholder}</option> : null}
        {options.map((option, i) => (
          <option key={`${option.value}-${i}`} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

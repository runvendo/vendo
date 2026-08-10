/**
 * Select — over RAW object arrays via labelField/valueField (W2 §The Kit).
 * The model passes tool output straight in; no `asOptions` reshape needed.
 * `multiple` folds in MultiSelect.
 */
import { control, font, t } from "../tokens.js";
import { FieldShell, useFieldIds, useReportNothingToOffer } from "./field.js";

export type SelectOption = string | number | Record<string, unknown>;

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
  /** Words shown in place of the dropdown when there is nothing to choose. */
  emptyState?: string;
  /** Bound change handler; receives the selected value(s). */
  onChange?: (value: string | string[]) => void;
}

function optionValue(opt: SelectOption, valueField?: string): string {
  if (opt !== null && typeof opt === "object") return String(valueField ? opt[valueField] : JSON.stringify(opt));
  return String(opt);
}

function optionLabel(opt: SelectOption, labelField?: string): string {
  if (opt !== null && typeof opt === "object") return String(labelField ? opt[labelField] : optionValue(opt));
  return String(opt);
}

export function Select({ label, options: rawOptions, labelField, valueField, value, placeholder, hint, disabled, required, multiple, emptyState = "Nothing to choose from", onChange }: SelectProps) {
  const { fieldId, helpId } = useFieldIds("select");
  // W3 — fail SOFT on missing data (a failed query resolves to undefined).
  const options = Array.isArray(rawOptions) ? rawOptions : [];
  // An empty query is an ANSWER, so say it: a dropdown with no options renders as
  // a blank control that tells the person nothing and hands its form no value.
  // The form hears it too (`useReportNothingToOffer`) and withholds its submit.
  useReportNothingToOffer(fieldId, options.length === 0);
  if (options.length === 0) {
    return (
      <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint}>
        <span id={fieldId} data-kit="Select" data-empty="" style={{ ...font, color: t.muted }}>
          {emptyState}
        </span>
      </FieldShell>
    );
  }
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint}>
      <select
        id={fieldId}
        data-kit="Select"
        multiple={multiple}
        defaultValue={value}
        disabled={disabled}
        required={required}
        aria-describedby={hint ? helpId : undefined}
        onChange={(e) => {
          if (multiple) {
            onChange?.(Array.from(e.target.selectedOptions, (o) => o.value));
          } else {
            onChange?.(e.target.value);
          }
        }}
        style={{ ...control, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 }}
      >
        {placeholder !== undefined && !multiple ? <option value="">{placeholder}</option> : null}
        {options.map((opt, i) => {
          const v = optionValue(opt, valueField);
          return (
            <option key={`${v}-${i}`} value={v}>
              {optionLabel(opt, labelField)}
            </option>
          );
        })}
      </select>
    </FieldShell>
  );
}

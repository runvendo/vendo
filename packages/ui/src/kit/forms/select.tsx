/**
 * Select — over RAW object arrays via labelField/valueField (W2 §The Kit).
 * The model passes tool output straight in; no `asOptions` reshape needed.
 * `multiple` folds in MultiSelect.
 */
import { Fragment, type ComponentProps } from "react";
import { control, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";
import { choices, grouped, type KitOption } from "./options.js";

export type SelectOption = KitOption;

interface SelectOwnProps extends KitStyled {
  label?: string;
  /** Raw items — primitives or objects. An item's own `disabled` and `group`
   *  keys make it unselectable and file it under a heading. */
  options: SelectOption[];
  /** Object field for the visible label (defaults to the item itself). */
  labelField?: string;
  /** Object field for the value (defaults to the item itself). */
  valueField?: string;
  /** The chosen value — a list where `multiple`. */
  value?: string | string[];
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  /** Allow selecting several values. */
  multiple?: boolean;
  /** Bound change handler; receives the selected value(s). */
  onChange?: (value: string | string[]) => void;
}

/** Plus any `<select>` attribute, handed straight to the control. `style` stays
 *  the Kit's own — it dresses the ROOT the label and hint share, not the box. */
export type SelectProps = SelectOwnProps & KitEngine<ComponentProps<"select">, SelectOwnProps>;

export function Select({ label, options: rawOptions, labelField, valueField, value, placeholder, hint, disabled, required, multiple, onChange, style, children, pending, ...engine }: SelectProps & KitRendered) {
  const { fieldId, helpId } = useFieldIds("select");
  const options = choices(rawOptions, labelField, valueField);
  const screen = controlledHandler(value !== undefined, onChange);
  // A multiple select spells its value as a LIST where a single one spells it as
  // one string, so a screen that wrote one string for a multi-select means the
  // one-item list.
  const shown = multiple
    ? (Array.isArray(value) ? value : value === undefined ? [] : [value])
    : (Array.isArray(value) ? value[0] ?? "" : value ?? "");
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} style={style}>
      <select
        data-kit="Select"
        multiple={multiple}
        disabled={disabled}
        required={required}
        aria-describedby={hint ? helpId : undefined}
        {...given(engine)}
        id={fieldId}
        {...(screen === null ? { defaultValue: shown } : { value: shown })}
        onChange={(e) => {
          // The whole selection, not `e.target.value`: on a multiple select that
          // is only ever the FIRST option picked, which is what left a screen's
          // `(e) => setPicked(e.target.value)` holding nothing.
          const next = multiple ? Array.from(e.target.selectedOptions, (o) => o.value) : e.target.value;
          return screen === null ? onChange?.(next) : screen({ target: { value: next } });
        }}
        style={{ ...control, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 }}
      >
        {placeholder !== undefined && !multiple ? <option value="">{placeholder}</option> : null}
        {grouped(options).map((run, g) => {
          const items = run.items.map((option, i) => (
            <option key={`${option.value}-${i}`} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ));
          // An `<optgroup>` only where a run is NAMED: an ungrouped list is the
          // flat set of options it always was.
          return run.group === undefined
            ? <Fragment key={g}>{items}</Fragment>
            : <optgroup key={g} label={run.group}>{items}</optgroup>;
        })}
      </select>
    </FieldShell>
  );
}

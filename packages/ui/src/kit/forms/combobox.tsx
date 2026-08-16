/**
 * Combobox — type-to-filter over RAW tool output (W2 §The Kit).
 * Select's shape for a list too long to scan; the same labelField/valueField.
 */
import { Combobox as Base } from "@base-ui/react/combobox";
import type { ComponentProps } from "react";
import { control, popup, popupMotion, t, transitionFor, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";
import { choices, type KitChoice, type KitOption } from "./options.js";

interface ComboboxOwnProps extends KitStyled {
  label?: string;
  /** Raw items — primitives or objects. */
  options: KitOption[];
  labelField?: string;
  valueField?: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  /** Bound change handler; receives the chosen value. */
  onChange?: (value: string) => void;
}

/** Plus any Base UI `<Combobox.Root>` prop, handed straight to the combobox.
 *  `style` stays the Kit's own — it dresses the ROOT the label and hint share.
 *  Pinned to `KitChoice`: unpinned, the Root's item generic resolves to
 *  `unknown` and the spread drags the whole element's inference down with it. */
export type ComboboxProps = ComboboxOwnProps & KitEngine<ComponentProps<typeof Base.Root<KitChoice>>, ComboboxOwnProps>;

export function Combobox({ label, options: rawOptions, labelField, valueField, value, placeholder, hint, disabled, onChange, style, children, pending, ...engine }: ComboboxProps & KitRendered) {
  const { fieldId, helpId } = useFieldIds("combobox");
  const options = choices(rawOptions, labelField, valueField);
  const screen = controlledHandler(value !== undefined, onChange);
  const selected = options.find((option) => option.value === value) ?? null;
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} style={style}>
      <Base.Root
        items={options}
        disabled={disabled}
        {...given(engine)}
        // `{value,label}` items: Base UI reads the label for the input text and
        // the value for the selection, so neither needs a mapping function.
        {...(screen === null ? { defaultValue: selected } : { value: selected })}
        onValueChange={(next: KitChoice | null) => {
          const one = next?.value ?? "";
          return screen === null ? onChange?.(one) : screen({ target: { value: one } });
        }}
      >
        <Base.Input
          id={fieldId}
          data-kit="Combobox"
          placeholder={placeholder}
          aria-describedby={hint ? helpId : undefined}
          style={{ ...control, cursor: disabled ? "not-allowed" : "text", opacity: disabled ? 0.55 : 1 }}
        />
        <Base.Portal>
          <Base.Positioner sideOffset={4} style={{ zIndex: 2 }}>
            <Base.Popup style={(state) => ({ ...popup, ...popupMotion(state), maxHeight: 260, overflowY: "auto", minWidth: "var(--anchor-width)" })}>
              <Base.Empty style={{ color: t.muted, fontSize: "0.88em", padding: "6px 10px" }}>No match</Base.Empty>
              <Base.List>
                {(option: KitChoice) => (
                  <Base.Item
                    key={option.value}
                    value={option}
                    style={({ selected: isSelected, highlighted }) => ({
                      borderRadius: t.radiusSmall,
                      color: isSelected ? t.accent : t.text,
                      background: highlighted ? t.surfaceRaised : "transparent",
                      cursor: "pointer",
                      fontWeight: isSelected ? t.weightEmphasis : t.weightNormal,
                      padding: "6px 10px",
                      transition: transitionFor("background-color", "color"),
                    })}
                  >
                    {option.label}
                  </Base.Item>
                )}
              </Base.List>
            </Base.Popup>
          </Base.Positioner>
        </Base.Portal>
      </Base.Root>
    </FieldShell>
  );
}

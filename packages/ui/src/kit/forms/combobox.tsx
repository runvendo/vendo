/**
 * Combobox — type-to-filter over RAW tool output (W2 §The Kit).
 * Select's shape for a list too long to scan; the same labelField/valueField.
 */
import { Combobox as Base } from "@base-ui/react/combobox";
import { Fragment, type ComponentProps } from "react";
import { control, microLabel, popup, popupMotion, t, transitionFor, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";
import { choices, grouped, type KitChoice, type KitOption, type KitRun } from "./options.js";

interface ComboboxOwnProps extends KitStyled {
  label?: string;
  /** Raw items — primitives or objects. An item's own `disabled` and `group`
   *  keys make it unselectable and file it under a heading. */
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
        // Base UI reads a `{group, items}` array as its own grouped shape, and
        // filters run by run — so ONE list feeds both the flat popup and the
        // grouped one, and an ungrouped list comes back as a single run.
        items={grouped(options)}
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
                {(run: KitRun<KitChoice>, g: number) => {
                  const items = run.items.map((option) => (
                    <Base.Item
                      key={option.value}
                      value={option}
                      disabled={option.disabled}
                      style={({ selected: isSelected, highlighted, disabled: isDisabled }) => ({
                        borderRadius: t.radiusSmall,
                        color: isDisabled ? t.muted : isSelected ? t.accent : t.text,
                        background: highlighted ? t.surfaceRaised : "transparent",
                        cursor: isDisabled ? "not-allowed" : "pointer",
                        fontWeight: isSelected ? t.weightEmphasis : t.weightNormal,
                        padding: "6px 10px",
                        transition: transitionFor("background-color", "color"),
                      })}
                    >
                      {option.label}
                    </Base.Item>
                  ));
                  // A heading only where the raw items named a group; an ungrouped
                  // list is the flat popup it always was.
                  return run.group === undefined ? <Fragment key={g}>{items}</Fragment> : (
                    <Base.Group key={g} items={run.items}>
                      <Base.GroupLabel style={{ ...microLabel, padding: "6px 10px" }}>{run.group}</Base.GroupLabel>
                      {items}
                    </Base.Group>
                  );
                }}
              </Base.List>
            </Base.Popup>
          </Base.Positioner>
        </Base.Portal>
      </Base.Root>
    </FieldShell>
  );
}

/** Slider — a number picked along a range; arrow keys step it (W2 §The Kit). */
import { Slider as Base } from "@base-ui/react/slider";
import type { ComponentProps } from "react";
import { font, hairline, numeric, t, transitionFor, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";

interface SliderOwnProps extends KitStyled {
  label?: string;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  /** Show the current number beside the label. */
  showValue?: boolean;
  hint?: string;
  disabled?: boolean;
  /** Bound change handler; receives the new number. */
  onChange?: (value: number) => void;
}

/** Plus any Base UI `<Slider.Root>` prop, handed straight to the slider. `style`
 *  stays the Kit's own — it dresses the ROOT the label and hint share. */
export type SliderProps = SliderOwnProps & KitEngine<ComponentProps<typeof Base.Root>, SliderOwnProps>;

export function Slider({ label, value, min = 0, max = 100, step = 1, showValue = false, hint, disabled, onChange, style, children, pending, ...engine }: SliderProps & KitRendered) {
  const { fieldId, helpId } = useFieldIds("slider");
  const screen = controlledHandler(value !== undefined, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} style={style}>
      <Base.Root
        data-kit="Slider"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        {...given(engine)}
        {...(screen === null ? { defaultValue: value ?? min } : { value: value ?? min })}
        onValueChange={(next) => {
          const one = Array.isArray(next) ? next[0]! : next;
          return screen === null ? onChange?.(one) : screen({ target: { value: one } });
        }}
        style={{ ...font, display: "flex", flexDirection: "column", gap: 4, opacity: disabled ? 0.55 : 1 }}
      >
        {showValue ? <Base.Value style={{ ...numeric, alignSelf: "flex-end", fontSize: "0.85em", fontWeight: t.weightEmphasis }} /> : null}
        <Base.Control style={{ display: "flex", alignItems: "center", minHeight: 20, cursor: disabled ? "not-allowed" : "pointer" }}>
          <Base.Track style={{ width: "100%", height: 6, borderRadius: 999, background: `color-mix(in srgb, ${t.muted} 18%, ${t.surface})` }}>
            <Base.Indicator style={{ borderRadius: 999, background: t.accent }} />
            <Base.Thumb
              id={fieldId}
              aria-label={label}
              aria-describedby={hint ? helpId : undefined}
              style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                border: hairline,
                background: t.surface,
                boxShadow: t.shadowSmall,
                transition: transitionFor("border-color"),
              }}
            />
          </Base.Track>
        </Base.Control>
      </Base.Root>
    </FieldShell>
  );
}

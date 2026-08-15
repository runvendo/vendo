/** Slider — a number picked along a range; arrow keys step it (W2 §The Kit). */
import { Slider as Base } from "@base-ui/react/slider";
import { font, hairline, numeric, t, transitionFor } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";

export interface SliderProps {
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

export function Slider({ label, value, min = 0, max = 100, step = 1, showValue = false, hint, disabled, onChange }: SliderProps) {
  const { fieldId, helpId } = useFieldIds("slider");
  const screen = controlledHandler(value !== undefined, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint}>
      <Base.Root
        data-kit="Slider"
        {...(screen === null ? { defaultValue: value ?? min } : { value: value ?? min })}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
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

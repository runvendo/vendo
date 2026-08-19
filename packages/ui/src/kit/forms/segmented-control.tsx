/**
 * SegmentedControl — a few mutually exclusive choices as one bar (W2 §The Kit).
 * The filter switch that changes what is SHOWN; Radio is the form field.
 */
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { ComponentProps } from "react";
import { font, hairline, t, transitionFor, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { controlledHandler } from "../handler.js";

export type SegmentItem = string | number | { value?: string | number; label?: string | number; disabled?: boolean };

interface SegmentedControlOwnProps extends KitStyled {
  items: SegmentItem[];
  /** The initially selected segment's value. */
  value?: string;
  disabled?: boolean;
  /** Bound change handler; receives the selected value. */
  onChange?: (value: string) => void;
}

/** Plus any Base UI `<ToggleGroup>` prop, handed straight to the bar — which is
 *  this control's ROOT, so the Kit's own `style` dresses it. */
export type SegmentedControlProps = SegmentedControlOwnProps & KitEngine<ComponentProps<typeof ToggleGroup>, SegmentedControlOwnProps>;

const text = (value: string | number | undefined): string => value === undefined || value === null ? "" : String(value);

export function SegmentedControl({ items, value, disabled, onChange, style, children, pending, ...engine }: SegmentedControlProps & KitRendered) {
  const segments = (items ?? []).map((item) => typeof item === "object" && item !== null
    ? { value: text(item.value ?? item.label), label: text(item.label ?? item.value), disabled: item.disabled ?? false }
    : { value: text(item), label: text(item), disabled: false });
  const screen = controlledHandler(value !== undefined, onChange);
  // ToggleGroup speaks in arrays; this control is single-choice, so the one
  // pressed segment is the whole value.
  const selected = value === undefined ? undefined : [value];
  return (
    <ToggleGroup
      data-kit="SegmentedControl"
      disabled={disabled}
      {...given(engine)}
      // Single-choice is radio semantics: one of these is always the answer.
      role="radiogroup"
      {...(screen === null ? { defaultValue: selected } : { value: selected ?? [] })}
      onValueChange={(next, details) => {
        // Pressing the LIVE segment again un-presses it, and this bar spelled
        // that empty selection as the value `""` — a value no segment has, which
        // a screen handed straight to a tool call while its filter switch went
        // blank. One of these choices is always the answer, so the press is a
        // no-op, and `cancel` is what keeps an unbound bar from un-pressing
        // itself too (Base UI ToggleGroup skips its own state write).
        if (next.length === 0) return details.cancel();
        const one = String(next[0]);
        return screen === null ? onChange?.(one) : screen({ target: { value: one } });
      }}
      style={{
        ...font,
        display: "inline-flex",
        gap: "var(--vendo-density-inline-gap, 7px)",
        maxWidth: "100%",
        overflowX: "auto",
        border: hairline,
        borderRadius: t.radiusMedium,
        background: t.surfaceRaised,
        padding: "var(--vendo-density-tabs-padding, 4px)",
        ...style,
      }}
    >
      {segments.map((segment, i) => (
        <Toggle
          key={`${segment.value}-${i}`}
          value={segment.value}
          disabled={segment.disabled}
          // `aria-pressed` is a toggle's word, and on a single-choice bar it
          // hides which segment is live from anything reading state — pressing
          // the active one is a no-op BY DESIGN, and only radio semantics say
          // so. Base UI stamps aria-pressed on the button it renders, so the
          // swap happens here, on the rendered node.
          render={(props, state) => <button {...props} role="radio" aria-checked={state.pressed} aria-pressed={undefined} />}
          // Base UI hands the state to `style`, so the selected look is painted
          // with no stylesheet to select `[data-pressed]` on.
          style={({ pressed }) => ({
            ...font,
            minHeight: "var(--vendo-density-tab-height, 30px)",
            border: pressed ? hairline : `${t.borderWidth} solid transparent`,
            borderRadius: t.radiusSmall,
            color: pressed ? t.accent : t.muted,
            background: pressed ? t.surface : "transparent",
            cursor: segment.disabled ? "not-allowed" : "pointer",
            fontSize: "0.88em",
            fontWeight: pressed ? t.weightEmphasis : t.weightNormal,
            opacity: segment.disabled ? 0.5 : 1,
            padding: "var(--vendo-density-tab-padding, 6px 10px)",
            whiteSpace: "nowrap",
            transition: transitionFor("background-color", "border-color", "color"),
          })}
        >
          {segment.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

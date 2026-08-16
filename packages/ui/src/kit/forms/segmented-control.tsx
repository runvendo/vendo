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
  // pressed segment is the whole value and un-pressing it selects nothing.
  const selected = value === undefined ? undefined : [value];
  return (
    <ToggleGroup
      data-kit="SegmentedControl"
      disabled={disabled}
      {...given(engine)}
      {...(screen === null ? { defaultValue: selected } : { value: selected ?? [] })}
      onValueChange={(next) => {
        const one = String(next[0] ?? "");
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

/** Progress — a themed progress bar; ratio or value/max (W2 §The Kit). */
import { Progress as Base } from "@base-ui/react/progress";
import type { ComponentProps, ReactNode } from "react";
import { isRenderableNumber } from "../format.js";
import { font, microLabel, numeric, resolveTone, t, toneColor, transitionFor, type KitStyled, type KitTone, type KitEngine, type KitRendered, given } from "../tokens.js";

interface ProgressOwnProps extends KitStyled {
  /** A ratio (0..1) unless `max` is given, then a raw value. */
  value?: number;
  /** When set, `value/max` is the ratio. */
  max?: number;
  /** The caption over the bar: a word, or Kit marks composed into one. */
  label?: ReactNode;
  /** Show the percentage text. */
  showValue?: boolean;
  tone?: KitTone;
}

/** Plus any Base UI `<Progress.Root>` prop, handed straight to the bar. It
 *  arrives AFTER the Kit's own defaults and BEFORE `value`, which the component
 *  owns — it is the clamped ratio the caller's own `value`/`max` resolved to. */
export type ProgressProps = ProgressOwnProps & KitEngine<ComponentProps<typeof Base.Root>, ProgressOwnProps>;

export function Progress({ value, max, label, showValue = false, tone, style, children, pending, ...engine }: ProgressProps & KitRendered) {
  if (!isRenderableNumber(value) || (max !== undefined && !isRenderableNumber(max))) {
    return (
      <div data-kit="Progress" style={{ ...font, color: t.muted, ...style }}>
        —
      </div>
    );
  }
  const ratio = max !== undefined && max !== 0 ? value / max : value;
  const clamped = Math.max(0, Math.min(1, ratio));
  // The bar stops at 100%, so past the cap the printed figure is the only
  // honest reading of how far past it went: a label saying "100%" at 1.2 is a
  // wrong number, not a style. The COLOR says nothing about it — whether over
  // is bad news is the caller's to state with `tone`.
  const over = ratio > 1;
  const pct = `${Math.round((over ? ratio : clamped) * 100)}%`;
  return (
    <div data-kit="Progress" style={{ ...font, display: "flex", flexDirection: "column", gap: 4, ...style }}>
      {(label || showValue) && (
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, fontSize: "0.85em" }}>
          {label ? <span style={microLabel}>{label}</span> : <span />}
          {showValue ? <span style={{ ...numeric, fontWeight: t.weightEmphasis }}>{pct}</span> : null}
        </div>
      )}
      {/* Base UI's Root IS the bar — it carries `role="progressbar"`, the aria
          value triple and the `data-complete`/`data-indeterminate` state — and
          its Indicator is the fill. The Track part is skipped because it would
          only add a wrapper between the two. */}
      <Base.Root
        // The ratio is `ChartFrame`'s intrinsic-width trick (charts/sanitize.tsx)
        // at a meter's proportion: an unlabelled bar has no content, so a parent
        // that sizes to what is inside it (the Kit's `Row`) resolved this
        // `width: 100%` to zero and the bar vanished. A parent with a real width
        // still wins.
        style={{ width: "100%", aspectRatio: "16 / 1", height: 8, borderRadius: 999, background: `color-mix(in srgb, ${t.muted} 18%, ${t.surface})`, overflow: "hidden" }}
        {...given(engine)}
        value={Math.round(clamped * 100)}
      >
        <Base.Indicator
          style={{
            height: "100%",
            borderRadius: 999,
            background: toneColor(resolveTone(tone, "accent")),
            transition: transitionFor("width"),
          }}
        />
      </Base.Root>
    </div>
  );
}

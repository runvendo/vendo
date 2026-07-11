/**
 * Glass skeleton (2026-07-05, Yousef-approved recipe): the landing page's
 * "view taking shape" panel transplanted into the shell's loading moments.
 * A frosted glass surface holds a pulse-dot status line and a grid of
 * accent-tinted shimmer blocks laid out like the view actually forming —
 * 3 stat tiles, a wide chart, two rows.
 *
 * Tokens are derived from the EXISTING host theme (styles.css): the shimmer
 * tint is `--vendo-accent`, the radius is `--vendo-radius`, and the glass
 * ground flips with the host scheme via `light-dark()` — no new theme keys.
 * Real backdrop blur only works in shell chrome; inside the sandboxed iframe
 * the translucent fill IS the fallback, which the recipe's background already
 * provides. Reduced motion freezes the sweep; the blocks stay tinted.
 *
 * This is a different moment from FluidThinking (chat "thinking") — the two
 * complement, never compete.
 */

export interface GlassSkeletonProps {
  /** The pulse-dot status line. */
  label?: string;
}

export function GlassSkeleton({ label = "Building your view…" }: GlassSkeletonProps) {
  return (
    <div className="fl-glass fl-glass-skeleton">
      <div className="fl-glass-line">
        <span className="fl-glass-dot" aria-hidden="true" />
        {label}
      </div>
      <div className="fl-glass-grid" aria-hidden="true">
        <div className="fl-glass-shimmer fl-glass-tile" />
        <div className="fl-glass-shimmer fl-glass-tile" />
        <div className="fl-glass-shimmer fl-glass-tile" />
        <div className="fl-glass-shimmer fl-glass-chart" />
        <div className="fl-glass-shimmer fl-glass-row" />
        <div className="fl-glass-shimmer fl-glass-row is-short" />
      </div>
    </div>
  );
}

/**
 * An absolutely-positioned, pointer-transparent shimmer for repaint moments.
 * The parent container must be positioned (`position: relative`).
 */
export function GlassVeil() {
  return <div className="fl-glass-veil fl-glass-shimmer" aria-hidden="true" />;
}

import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { progressSchema } from "./descriptor";

const MUTED = "var(--vendo-fg-muted, rgba(0,0,0,0.55))";

export const Progress = createPrewiredImpl(progressSchema, (p) => {
  const max = p.max ?? 100;
  const pct = Math.max(0, Math.min(100, (p.value / max) * 100));
  return (
    <div data-progress style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {(p.label || p.display) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          {p.label ? <span style={{ fontSize: 13, color: MUTED }}>{p.label}</span> : <span />}
          {p.display ? (
            <span style={{ fontSize: 13, fontVariantNumeric: "tabular-nums", color: "var(--vendo-fg, inherit)" }}>
              {p.display}
            </span>
          ) : null}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={Math.round(p.value)}
        aria-valuemin={0}
        aria-valuemax={Math.round(max)}
        style={{ height: 8, borderRadius: 999, background: "var(--vendo-skeleton, rgba(0,0,0,0.08))", overflow: "hidden" }}
      >
        <div
          data-progress-fill
          style={{ width: `${pct}%`, height: "100%", borderRadius: 999, background: "var(--vendo-accent, #111)" }}
        />
      </div>
    </div>
  );
});

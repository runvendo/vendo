import { createPrewiredImpl } from "../../impl-helpers/create-impl.js";
import { emptyStateSchema } from "./descriptor.js";

const MUTED = "var(--vendo-fg-muted, rgba(0,0,0,0.55))";

function Glyph({ variant }: { variant: "empty" | "error" }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden style={{ color: MUTED }}>
      <circle cx="14" cy="14" r="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={variant === "empty" ? "3 3" : undefined} />
      {variant === "error" ? (
        <>
          <line x1="14" y1="8" x2="14" y2="15.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="14" cy="19.5" r="1.3" fill="currentColor" />
        </>
      ) : (
        <line x1="9" y1="14" x2="19" y2="14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
    </svg>
  );
}

export const EmptyState = createPrewiredImpl(emptyStateSchema, (p) => (
  <div
    data-empty-state={p.variant}
    style={{
      display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center",
      gap: 8, padding: "32px 24px",
      border: "1px dashed var(--vendo-border, rgba(0,0,0,0.15))",
      borderRadius: "var(--vendo-radius, 12px)",
    }}
  >
    <Glyph variant={p.variant} />
    <div style={{ fontSize: 14.5, fontWeight: 600, color: "var(--vendo-fg, inherit)" }}>{p.title}</div>
    {p.message ? <div style={{ fontSize: 13, color: MUTED, maxWidth: 380 }}>{p.message}</div> : null}
  </div>
));

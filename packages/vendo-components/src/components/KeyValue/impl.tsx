import { Fragment } from "react";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { keyValueSchema } from "./descriptor";

const MUTED = "var(--vendo-fg-muted, rgba(0,0,0,0.55))";
const BORDER = "1px solid var(--vendo-border, rgba(0,0,0,0.08))";

export const KeyValue = createPrewiredImpl(keyValueSchema, (p) => (
  <div data-keyvalue>
    {p.title ? (
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: MUTED, marginBottom: 10 }}>
        {p.title}
      </div>
    ) : null}
    <div style={{ display: "flex", flexDirection: "column" }}>
      {p.rows.map((row, i) => (
        <Fragment key={`${row.label}-${i}`}>
          {i > 0 ? <div aria-hidden style={{ borderTop: BORDER }} /> : null}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, padding: "9px 0" }}>
            <span style={{ fontSize: 13, color: MUTED }}>{row.label}</span>
            <span
              style={{
                fontSize: row.emphasis ? 15 : 13.5,
                fontWeight: row.emphasis ? 650 : 450,
                fontVariantNumeric: "tabular-nums",
                color: "var(--vendo-fg, inherit)",
                textAlign: "right",
              }}
            >
              {row.value}
            </span>
          </div>
        </Fragment>
      ))}
    </div>
  </div>
));

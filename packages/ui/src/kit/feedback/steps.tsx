/** Steps — a progress trail: what is done, what is happening, what is left
 *  (W2 §The Kit). Everything before `active` reads as done. */
import { Icon } from "../icon.js";
import { font, hairline, t } from "../tokens.js";

export interface StepItem {
  label: string;
  description?: string;
}

export interface StepsProps {
  /** The steps, in order. */
  items: StepItem[];
  /** Index of the current step. */
  active?: number;
  orientation?: "horizontal" | "vertical";
}

type StepState = "done" | "current" | "todo";

export function Steps({ items = [], active = 0, orientation = "horizontal" }: StepsProps) {
  const vertical = orientation === "vertical";
  return (
    <ol
      data-kit="Steps"
      data-orientation={orientation}
      style={{
        ...font,
        display: "flex",
        flexDirection: vertical ? "column" : "row",
        gap: vertical ? "var(--vendo-density-content-gap, 10px)" : "var(--vendo-density-inline-gap, 7px)",
        listStyle: "none",
        margin: 0,
        padding: 0,
      }}
    >
      {items.map((item, index) => {
        const state: StepState = index < active ? "done" : index === active ? "current" : "todo";
        // The rule leading each step is the progress itself — accent behind and
        // at the current step, the plain hairline ahead of it.
        const rule = `2px solid ${state === "todo" ? t.border : t.accent}`;
        return (
          <li
            key={`${item.label}-${index}`}
            data-step-state={state}
            {...(state === "current" ? { "aria-current": "step" } : {})}
            style={{
              display: "flex",
              gap: "var(--vendo-density-inline-gap, 7px)",
              minWidth: 0,
              ...(vertical
                ? { borderInlineStart: rule, paddingInlineStart: 10 }
                : { flex: "1 1 0", borderBlockStart: rule, paddingBlockStart: 8 }),
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                width: 20,
                height: 20,
                borderRadius: "50%",
                border: state === "current" ? `calc(${t.borderWidth} * 2) solid ${t.accent}` : hairline,
                background: state === "done" ? t.accent : "transparent",
                color: state === "done" ? t.accentText : state === "current" ? t.accent : t.muted,
                fontSize: "0.68em",
                fontWeight: t.weightEmphasis,
                fontVariantNumeric: "tabular-nums",
                lineHeight: 1,
              }}
            >
              {state === "done" ? <Icon name="check" size={12} /> : index + 1}
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span
                style={{
                  color: state === "todo" ? t.muted : t.text,
                  fontSize: "0.9em",
                  fontWeight: state === "current" ? t.weightEmphasis : t.weightNormal,
                  letterSpacing: "-0.01em",
                }}
              >
                {item.label}
              </span>
              {item.description ? (
                <span style={{ color: t.muted, fontSize: "0.78em", lineHeight: 1.4 }}>{item.description}</span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

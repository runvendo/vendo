/** Tabs — self-managing; the model gives tabs + panels, no state plumbing (W2).
 *
 *  V4 (one component family): this absorbed the retired tree primitive's WIRE
 *  contract, because the plan skeleton emits tabs as a TREE node
 *  (packages/apps generation/skeleton.ts) and a wire attribute cannot hold an
 *  element. So a tab item may be a plain string or `{value,label}`, `value`
 *  picks the initial tab by value, and PANELS ARRIVE AS CHILDREN in tab order.
 *  The code-only `{label, content}` item still works; children win when both
 *  are present.
 */
import { Children, useId, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { font, hairline, t, transitionFor } from "../tokens.js";

export type TabItem = string | number | {
  value?: string | number;
  label?: string | number;
  disabled?: boolean;
  /** Code-only inline panel. Wire trees nest panels as children instead. */
  content?: ReactNode;
};

export interface TabsProps {
  tabs: TabItem[];
  /** The initially selected tab's `value` (the wire dialect's selector). */
  value?: string | number;
  /** Index of the initially selected tab. Ignored when `value` names a tab. */
  defaultIndex?: number;
  /** One panel per tab, in tab order. Wins over an item's `content`. */
  children?: ReactNode;
}

const text = (value: string | number | undefined): string =>
  value === undefined || value === null ? "" : String(value);

interface NormalTab {
  value: string;
  label: string;
  disabled: boolean;
  content: ReactNode;
}

const normalize = (item: TabItem): NormalTab => {
  if (typeof item !== "object" || item === null) {
    return { value: text(item), label: text(item), disabled: false, content: undefined };
  }
  return {
    value: text(item.value ?? item.label),
    label: text(item.label ?? item.value),
    disabled: item.disabled ?? false,
    content: item.content,
  };
};

export function Tabs({ tabs, value, defaultIndex = 0, children }: TabsProps) {
  const panels = Children.toArray(children);
  const items = (tabs ?? []).map(normalize);
  const panelIdBase = useId().replace(/:/g, "");
  // `value` names a tab; otherwise fall back to defaultIndex. Either way a
  // disabled starting tab hands off to the first enabled one.
  const named = value === undefined ? -1 : items.findIndex((item) => item.value === text(value));
  const requested = named === -1 ? defaultIndex : named;
  const firstEnabled = items.findIndex((item) => !item.disabled);
  const [active, setActive] = useState(
    items[requested] !== undefined && !items[requested].disabled ? requested : Math.max(0, firstEnabled),
  );

  const focusTab = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const offsets: Partial<Record<string, number>> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    const offset = offsets[event.key];
    if (offset === undefined && event.key !== "Home" && event.key !== "End") return;
    const buttons = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [],
    );
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, buttons.indexOf(event.currentTarget));
    const target = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (current + (offset ?? 0) + buttons.length) % buttons.length;
    buttons[target]?.focus();
  };

  return (
    <div data-kit="Tabs" style={{ ...font, display: "flex", flexDirection: "column", gap: "var(--vendo-density-content-gap, 10px)" }}>
      <div
        role="tablist"
        style={{
          display: "flex",
          gap: "var(--vendo-density-inline-gap, 7px)",
          width: "fit-content",
          maxWidth: "100%",
          overflowX: "auto",
          border: hairline,
          borderRadius: t.radiusMedium,
          background: t.surfaceRaised,
          padding: "var(--vendo-density-tabs-padding, 4px)",
        }}
      >
        {items.map((tab, i) => {
          const selected = i === active;
          return (
            <button
              key={`${tab.value}-${i}`}
              id={`${panelIdBase}-tab-${i}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${panelIdBase}-panel-${i}`}
              tabIndex={selected ? 0 : -1}
              disabled={tab.disabled}
              onClick={() => setActive(i)}
              onKeyDown={focusTab}
              style={{
                ...font,
                minHeight: "var(--vendo-density-tab-height, 30px)",
                border: selected ? hairline : `${t.borderWidth} solid transparent`,
                borderRadius: t.radiusSmall,
                // Accent marks the ACTIVE state — the tablist's one brand pixel.
                color: selected ? t.accent : t.muted,
                background: selected ? t.surface : "transparent",
                cursor: tab.disabled ? "not-allowed" : "pointer",
                fontSize: "0.88em",
                fontWeight: selected ? t.weightEmphasis : t.weightNormal,
                opacity: tab.disabled ? 0.5 : 1,
                padding: "var(--vendo-density-tab-padding, 6px 10px)",
                whiteSpace: "nowrap",
                // The indicator glide: the fill and the rule travel to the tab
                // that was pressed instead of jumping.
                transition: transitionFor("background-color", "border-color", "color"),
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${panelIdBase}-panel-${active}`}
        aria-labelledby={`${panelIdBase}-tab-${active}`}
      >
        {panels.length > 0 ? panels[active] : items[active]?.content}
      </div>
    </div>
  );
}

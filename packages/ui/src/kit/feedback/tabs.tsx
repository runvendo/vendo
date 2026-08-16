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
import { Tabs as Base } from "@base-ui/react/tabs";
import { Children, type ReactNode } from "react";
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
  /** Kit elements at the end of the tab row — what the whole set does. */
  actions?: ReactNode;
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

export function Tabs({ tabs, value, defaultIndex = 0, actions, children }: TabsProps) {
  const panels = Children.toArray(children);
  const items = (tabs ?? []).map(normalize);
  // Tabs are addressed by INDEX, because two items may carry the same `value`
  // (or none at all) and Base UI keys its panels off the tab's value.
  // `value` names a tab; otherwise fall back to defaultIndex. Either way a
  // disabled starting tab hands off to the first enabled one.
  const named = value === undefined ? -1 : items.findIndex((item) => item.value === text(value));
  const requested = named === -1 ? defaultIndex : named;
  const firstEnabled = items.findIndex((item) => !item.disabled);
  const start = items[requested] !== undefined && !items[requested].disabled
    ? requested
    : Math.max(0, firstEnabled);

  return (
    <Base.Root
      data-kit="Tabs"
      defaultValue={start}
      style={{ ...font, display: "flex", flexDirection: "column", gap: "var(--vendo-density-content-gap, 10px)" }}
    >
      {/* The list keeps its fit-content width; the row around it is what lets
          `actions` sit at the far end instead of under the tabs. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--vendo-density-inline-gap, 7px)" }}>
        <Base.List
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
          {items.map((tab, i) => (
            <Base.Tab
              key={`${tab.value}-${i}`}
              value={i}
              disabled={tab.disabled}
              // Base UI hands the state to `style`, so the selected look is
              // painted with no stylesheet to select `[data-active]` on.
              style={({ active }) => ({
                ...font,
                minHeight: "var(--vendo-density-tab-height, 30px)",
                border: active ? hairline : `${t.borderWidth} solid transparent`,
                borderRadius: t.radiusSmall,
                // Accent marks the ACTIVE state — the tablist's one brand pixel.
                color: active ? t.accent : t.muted,
                background: active ? t.surface : "transparent",
                cursor: tab.disabled ? "not-allowed" : "pointer",
                fontSize: "0.88em",
                fontWeight: active ? t.weightEmphasis : t.weightNormal,
                opacity: tab.disabled ? 0.5 : 1,
                padding: "var(--vendo-density-tab-padding, 6px 10px)",
                whiteSpace: "nowrap",
                // The indicator glide: the fill and the rule travel to the tab
                // that was pressed instead of jumping.
                transition: transitionFor("background-color", "border-color", "color"),
              })}
            >
              {tab.label}
            </Base.Tab>
          ))}
        </Base.List>
        {actions}
      </div>
      {items.map((tab, i) => (
        <Base.Panel key={`${tab.value}-${i}`} value={i}>
          {panels.length > 0 ? panels[i] : tab.content}
        </Base.Panel>
      ))}
    </Base.Root>
  );
}

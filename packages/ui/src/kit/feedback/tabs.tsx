/** Tabs — self-managing; the model gives tabs + content, no state plumbing (W2). */
import { useState, type ReactNode } from "react";
import { font, t } from "../tokens.js";

export interface TabItem {
  label: string;
  content: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  /** Index of the initially selected tab. */
  defaultIndex?: number;
}

export function Tabs({ tabs, defaultIndex = 0 }: TabsProps) {
  const firstEnabled = tabs.findIndex((tabItem) => !tabItem.disabled);
  const [active, setActive] = useState(tabs[defaultIndex]?.disabled ? Math.max(0, firstEnabled) : defaultIndex);
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
          border: `1px solid ${t.border}`,
          borderRadius: t.radiusMedium,
          background: `color-mix(in srgb, ${t.background} 72%, ${t.surface})`,
          padding: "var(--vendo-density-tabs-padding, 4px)",
        }}
      >
        {tabs.map((tab, i) => {
          const selected = i === active;
          return (
            <button
              key={`${tab.label}-${i}`}
              type="button"
              role="tab"
              aria-selected={selected}
              disabled={tab.disabled}
              onClick={() => setActive(i)}
              style={{
                ...font,
                minHeight: "var(--vendo-density-tab-height, 30px)",
                border: selected ? `1px solid ${t.border}` : "1px solid transparent",
                borderRadius: t.radiusSmall,
                color: selected ? t.text : t.muted,
                background: selected ? t.surface : "transparent",
                boxShadow: selected ? `0 1px 3px color-mix(in srgb, ${t.text} 10%, transparent)` : "none",
                cursor: tab.disabled ? "not-allowed" : "pointer",
                fontSize: "0.88em",
                fontWeight: selected ? 650 : 550,
                opacity: tab.disabled ? 0.5 : 1,
                padding: "var(--vendo-density-tab-padding, 6px 10px)",
                whiteSpace: "nowrap",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">{tabs[active]?.content}</div>
    </div>
  );
}

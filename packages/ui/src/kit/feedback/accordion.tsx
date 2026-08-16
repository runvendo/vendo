/** Accordion — self-managing collapsible sections (W2 §The Kit). */
import { Accordion as Base } from "@base-ui/react/accordion";
import type { CSSProperties, ReactNode } from "react";
import { font, hairline, t, transitionFor } from "../tokens.js";

export interface AccordionItem {
  label: string;
  content: ReactNode;
}

export interface AccordionProps {
  items: AccordionItem[];
  /** Allow more than one section open at once. */
  multiple?: boolean;
  /** Indices open on first render. */
  defaultOpen?: number[];
}

export function Accordion({ items, multiple = false, defaultOpen = [] }: AccordionProps) {
  return (
    <Base.Root
      data-kit="Accordion"
      multiple={multiple}
      defaultValue={defaultOpen}
      style={{ ...font, border: hairline, borderRadius: t.radiusMedium, overflow: "hidden", background: t.surface }}
    >
      {(items ?? []).map((item, i) => (
        // Sections are addressed by INDEX: two items may carry the same label,
        // and Base UI keys its panels off the item's value.
        <Base.Item key={`${item.label}-${i}`} value={i} style={{ borderTop: i === 0 ? 0 : hairline }}>
          <Base.Header style={{ margin: 0 }}>
            <Base.Trigger
              // Base UI hands the state to `style`, so the open look is painted
              // with no stylesheet to select `[data-panel-open]` on. The marker's
              // turn rides down as a custom property because a child cannot read
              // the state its parent was given.
              style={({ open }) => ({
                ...font,
                display: "flex",
                width: "100%",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                border: 0,
                background: "transparent",
                cursor: "pointer",
                fontWeight: t.weightEmphasis,
                padding: "var(--vendo-density-card-padding, 12px 14px)",
                textAlign: "left",
                transition: transitionFor("background-color", "color"),
                "--vendo-accordion-mark": open ? "rotate(90deg)" : "none",
              } as CSSProperties)}
            >
              {item.label}
              <span aria-hidden="true" style={{ color: t.muted, transform: "var(--vendo-accordion-mark, none)", transition: transitionFor("transform") }}>
                ›
              </span>
            </Base.Trigger>
          </Base.Header>
          <Base.Panel style={{ padding: "0 14px var(--vendo-density-card-padding, 14px)", color: t.text }}>
            {item.content}
          </Base.Panel>
        </Base.Item>
      ))}
    </Base.Root>
  );
}

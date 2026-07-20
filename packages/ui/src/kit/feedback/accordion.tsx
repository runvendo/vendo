/** Accordion — self-managing collapsible sections (W2 §The Kit). */
import { useState, type ReactNode } from "react";
import { font, t } from "../tokens.js";

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
  const [open, setOpen] = useState<Set<number>>(new Set(defaultOpen));
  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(multiple ? prev : []);
      if (prev.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <div
      data-kit="Accordion"
      style={{ ...font, border: `1px solid ${t.border}`, borderRadius: t.radiusMedium, overflow: "hidden", background: t.surface }}
    >
      {items.map((item, i) => {
        const isOpen = open.has(i);
        return (
          <div key={`${item.label}-${i}`} style={{ borderTop: i === 0 ? 0 : `1px solid ${t.border}` }}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => toggle(i)}
              style={{
                ...font,
                display: "flex",
                width: "100%",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                border: 0,
                background: "transparent",
                cursor: "pointer",
                fontWeight: 600,
                padding: "var(--vendo-density-card-padding, 12px 14px)",
                textAlign: "left",
              }}
            >
              {item.label}
              <span aria-hidden="true" style={{ color: t.muted, transform: isOpen ? "rotate(90deg)" : "none", transition: `transform ${t.motionDuration} ${t.motionEasing}` }}>
                ›
              </span>
            </button>
            {isOpen ? (
              <div style={{ padding: "0 14px var(--vendo-density-card-padding, 14px)", color: t.text }}>{item.content}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

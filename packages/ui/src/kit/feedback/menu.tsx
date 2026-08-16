/**
 * Menu — actions behind one trigger (W2 §The Kit).
 *
 * Dual API, for the same reason Tabs has one: `items` is what a WIRE tree can
 * express (plain data plus a single `onSelect`), and children are what code
 * reaches for when an entry needs more than a word. Children win when both are
 * given.
 */
import { Menu as Base } from "@base-ui/react/menu";
import { Children, type ComponentProps, type ReactNode } from "react";
import { Icon } from "../icon.js";
import { control, font, popup, popupMotion, t, transitionFor, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { isHandlerCallback } from "../handler.js";

export interface MenuItem {
  label: string;
  /** What `onSelect` receives; defaults to the label. */
  value?: string;
  /** lucide icon name in kebab-case. */
  icon?: string;
  disabled?: boolean;
}

interface MenuOwnProps extends KitStyled {
  /** The trigger's text. */
  label: string;
  items?: MenuItem[];
  /** Bound handler; receives the chosen item's value. */
  onSelect?: (value: string) => void;
  /** One entry per line, in place of `items`. */
  children?: ReactNode;
}

/** Plus any Base UI `<Menu.Root>` prop, handed straight to the menu. `style`
 *  stays the Kit's own — Menu.Root draws nothing, so it dresses the TRIGGER. */
export type MenuProps = MenuOwnProps & KitEngine<ComponentProps<typeof Base.Root>, MenuOwnProps>;

const itemStyle = ({ highlighted, disabled }: { highlighted: boolean; disabled: boolean }) => ({
  ...font,
  display: "flex",
  alignItems: "center",
  gap: "var(--vendo-density-inline-gap, 7px)",
  borderRadius: t.radiusSmall,
  background: highlighted ? t.surfaceRaised : "transparent",
  color: disabled ? t.muted : t.text,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.5 : 1,
  outline: "none",
  padding: "6px 10px",
  whiteSpace: "nowrap" as const,
  transition: transitionFor("background-color", "color"),
});

export function Menu({ label, items, onSelect, children, style, pending, ...engine }: MenuProps & KitRendered) {
  // A screen's handler reads the event its source was written against; every
  // other caller wants the value itself (kit/handler.ts).
  const fire = (value: string) => isHandlerCallback(onSelect)
    ? onSelect({ target: { value } })
    : onSelect?.(value);
  const entries = Children.toArray(children);
  return (
    <Base.Root {...given(engine)}>
      <Base.Trigger
        data-kit="Menu"
        style={{ ...control, display: "inline-flex", alignItems: "center", gap: 6, width: "auto", cursor: "pointer", ...style }}
      >
        {label}
        <Icon name="chevron-down" size={14} />
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner sideOffset={4} style={{ zIndex: 2 }}>
          <Base.Popup style={(state) => ({ ...popup, ...popupMotion(state), minWidth: 160 })}>
            {entries.length > 0
              ? entries.map((entry, i) => <Base.Item key={i} style={itemStyle}>{entry}</Base.Item>)
              : (items ?? []).map((item, i) => (
                <Base.Item
                  key={`${item.label}-${i}`}
                  disabled={item.disabled}
                  onClick={() => fire(item.value ?? item.label)}
                  style={itemStyle}
                >
                  {item.icon ? <Icon name={item.icon} /> : null}
                  {item.label}
                </Base.Item>
              ))}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

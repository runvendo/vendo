/**
 * Menu — actions behind one trigger (W2 §The Kit).
 *
 * ONE API: `items` plus one `onSelect`, which is what a WIRE tree can express.
 *
 * Children are REFUSED by the floor — Menu is childless in the Kit specs, and the
 * nesting check names `items={[…]}` + `onSelect` as the fix — because the branch
 * that used to accept them wrapped every child in an entry with NO handler. A
 * menu written that way opened, listed its entries, highlighted them on hover,
 * and did nothing at all when one was chosen. There is no version of that branch
 * worth keeping: a nested Menu cannot say which value an entry carries, so a
 * refusal that names the fix is the only outcome the author can act on.
 */
import { Menu as Base } from "@base-ui/react/menu";
import type { ComponentProps } from "react";
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
            {(items ?? []).map((item, i) => (
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

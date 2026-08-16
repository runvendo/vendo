/** Switch — an instant on/off setting (W2 §The Kit). */
import { Switch as Base } from "@base-ui/react/switch";
import type { ComponentProps } from "react";
import { hairline, t, transitionFor, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { FieldShell, useFieldIds } from "./field.js";

interface SwitchOwnProps extends KitStyled {
  label?: string;
  checked?: boolean;
  hint?: string;
  disabled?: boolean;
  /** Bound change handler; receives the new state. */
  onChange?: (checked: boolean) => void;
}

/** Plus any Base UI `<Switch.Root>` prop, handed straight to the track. `style`
 *  stays the Kit's own — it dresses the ROOT the label and hint share. */
export type SwitchProps = SwitchOwnProps & KitEngine<ComponentProps<typeof Base.Root>, SwitchOwnProps>;

const TRACK_WIDTH = 34;
const THUMB = 14;

export function Switch({ label, checked, hint, disabled, onChange, style, children, pending, ...engine }: SwitchProps & KitRendered) {
  const { fieldId, helpId } = useFieldIds("switch");
  // A screen owns its value (kit/handler.ts), exactly as Checkbox does.
  const screen = controlledHandler(checked !== undefined, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} inline style={style}>
      <Base.Root
        data-kit="Switch"
        disabled={disabled}
        aria-describedby={hint ? helpId : undefined}
        {...given(engine)}
        id={fieldId}
        {...(screen === null ? { defaultChecked: checked } : { checked: checked ?? false })}
        onCheckedChange={(next) => screen === null
          ? onChange?.(next)
          : screen({ target: { checked: next } })}
        style={({ checked: isOn }) => ({
          display: "inline-flex",
          alignItems: "center",
          width: TRACK_WIDTH,
          padding: 2,
          border: isOn ? `${t.borderWidth} solid ${t.accent}` : hairline,
          borderRadius: 999,
          background: isOn ? t.accent : t.surfaceRaised,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.55 : 1,
          transition: transitionFor("background-color", "border-color"),
        })}
      >
        <Base.Thumb
          style={({ checked: isOn }) => ({
            width: THUMB,
            height: THUMB,
            borderRadius: "50%",
            background: isOn ? t.accentText : t.surface,
            boxShadow: t.shadowSmall,
            // The thumb TRAVELS rather than teleporting — the one motion that
            // says the flip was heard.
            transform: `translateX(${isOn ? TRACK_WIDTH - THUMB - 6 : 0}px)`,
            transition: transitionFor("transform", "background-color"),
          })}
        />
      </Base.Root>
    </FieldShell>
  );
}

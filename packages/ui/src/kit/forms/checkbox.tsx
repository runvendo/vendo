/** Checkbox — boolean input; onChange reports checked (W2 §The Kit). */
import { Checkbox as Base } from "@base-ui/react/checkbox";
import { hairline, t, transitionFor } from "../tokens.js";
import { controlledHandler } from "../handler.js";
import { Icon } from "../icon.js";
import { FieldShell, useFieldIds } from "./field.js";

export interface CheckboxProps {
  label?: string;
  checked?: boolean;
  hint?: string;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}

export function Checkbox({ label, checked, hint, disabled, onChange }: CheckboxProps) {
  const { fieldId, helpId } = useFieldIds("checkbox");
  const screen = controlledHandler(checked !== undefined, onChange);
  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={label} hint={hint} inline>
      <Base.Root
        id={fieldId}
        data-kit="Checkbox"
        {...(screen === null ? { defaultChecked: checked } : { checked: checked ?? false })}
        disabled={disabled}
        aria-describedby={hint ? helpId : undefined}
        onCheckedChange={(next) => screen === null
          ? onChange?.(next)
          : screen({ target: { checked: next } })}
        style={({ checked: on }) => ({
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          // The border is part of the 16px footprint the native box had, not on
          // top of it — the Kit cannot assume a `box-sizing` reset in a host page.
          boxSizing: "border-box",
          width: 16,
          height: 16,
          border: on ? `${t.borderWidth} solid ${t.accent}` : hairline,
          borderRadius: t.radiusSmall,
          background: on ? t.accent : t.surface,
          color: t.accentText,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.55 : 1,
          transition: transitionFor("background-color", "border-color"),
        })}
      >
        <Base.Indicator style={{ display: "inline-flex" }}>
          <Icon name="check" size={12} />
        </Base.Indicator>
      </Base.Root>
    </FieldShell>
  );
}

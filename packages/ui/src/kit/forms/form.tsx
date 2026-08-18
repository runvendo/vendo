/** Form — groups fields with a submit action (W2 §The Kit). */
import { Form as Base } from "@base-ui/react/form";
import type { ComponentProps, FormEvent, ReactNode } from "react";
import { font, t, type KitEngine, type KitRendered, type KitStyled, given } from "../tokens.js";
import { Button } from "./button.js";

interface FormOwnProps extends KitStyled {
  /** Bound host-tool submit action (renderer-supplied). */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  submitLabel?: string;
  disabled?: boolean;
  /** Kit elements above the fields. */
  header?: ReactNode;
  /** Kit elements beside the submit — a cancel, a secondary action. */
  actions?: ReactNode;
  /** The fine print under the actions. */
  footer?: ReactNode;
}

/** Plus any Base UI `<Form>` prop, handed straight to the root — here the root
 *  IS the Base element, so the Kit's `style` dresses that same one. */
export type FormProps = FormOwnProps & KitEngine<ComponentProps<typeof Base>, FormOwnProps>;

export function Form({ onSubmit, submitLabel = "Submit", disabled, header, actions, footer, style, children, pending, ...engine }: FormProps & KitRendered) {
  return (
    // Base UI's Form validates the fields that registered with it and focuses
    // the first one that failed before ever reaching `onSubmit` — the half a
    // hand-rolled `<form>` never had.
    <Base
      data-kit="Form"
      onSubmit={(e) => {
        // A submit routes through `vendo.action` — never a native navigation.
        // Generated code cannot own that: its onSubmit often binds a hydrated
        // `$action` callback that takes no event argument at all, so it can
        // never call `preventDefault()` itself, and the native submission
        // fires in parallel. Form is the one place every Kit-composed submit
        // passes through, so it — not the generated code — owns preventDefault.
        e.preventDefault();
        // And by the same reasoning it owns the constraint check. Base UI's Form
        // validates the controls that REGISTER with it and marks the element
        // `noValidate`, so on the three fields that are still native — Textarea,
        // Select, Checkbox — a `required` decorated the label and stopped
        // nothing. The element's own validity is what those three answer to, and
        // this is the one place every submit passes through, so the field that
        // failed takes the focus and `onSubmit` is never called.
        const form = e.currentTarget;
        if (!form.checkValidity()) {
          form.querySelector<HTMLElement>(":invalid")?.focus();
          return;
        }
        onSubmit?.(e);
      }}
      {...given(engine)}
      style={{ ...font, display: "flex", flexDirection: "column", gap: "var(--vendo-density-content-gap, 10px)", ...style }}
    >
      {header}
      {children}
      {/* A row rather than a bare div, so the submit keeps its natural width in
          a stretched column and `actions` sits beside it. */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--vendo-density-inline-gap, 7px)" }}>
        <Button type="submit" label={submitLabel} disabled={disabled} />
        {actions}
      </div>
      {footer === undefined ? null : (
        <div style={{ color: t.muted, fontSize: "0.82em" }}>{footer}</div>
      )}
    </Base>
  );
}

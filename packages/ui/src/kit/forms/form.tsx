/** Form — groups fields with a submit action (W2 §The Kit). */
import { Form as Base } from "@base-ui/react/form";
import type { FormEvent, PropsWithChildren, ReactNode } from "react";
import { font, t } from "../tokens.js";
import { Button } from "./button.js";

export interface FormProps {
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

export function Form({ onSubmit, submitLabel = "Submit", disabled, header, actions, footer, children }: PropsWithChildren<FormProps>) {
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
        onSubmit?.(e);
      }}
      style={{ ...font, display: "flex", flexDirection: "column", gap: "var(--vendo-density-content-gap, 10px)" }}
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

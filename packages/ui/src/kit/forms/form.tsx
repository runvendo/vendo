/** Form — groups fields with a submit action (W2 §The Kit). */
import type { FormEvent, PropsWithChildren } from "react";
import { font } from "../tokens.js";
import { Button } from "./button.js";

export interface FormProps {
  /** Bound host-tool submit action (renderer-supplied). */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  submitLabel?: string;
  /** Emphasis of the submit button; Button owns the default (neutral). Without
   *  this the form's submit was hardwired to Button's old accent default, so a
   *  form that cancels or deletes could not be anything but brand-green. */
  submitVariant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
}

export function Form({ onSubmit, submitLabel = "Submit", submitVariant, disabled, children }: PropsWithChildren<FormProps>) {
  return (
    <form
      data-kit="Form"
      onSubmit={(e) => {
        // The jail sandbox deliberately carries no `allow-forms` (island
        // security posture: no form target should ever be able to navigate
        // or POST out of the frame). A submit is meant to route through
        // `vendo.action`/`tools` instead — but a generated island's own
        // onSubmit handler often binds a hydrated `$action` callback that
        // takes no event argument at all, so it can never call
        // `preventDefault()` itself. Without this, the native submission
        // still fires in parallel and the browser blocks it with a console
        // error ("sandboxed and 'allow-forms' is not set") — the intended
        // action call may still have gone out, but the form never resolves
        // visibly. Form is the one place every Kit-composed submit passes
        // through, so it — not the generated code — owns preventDefault.
        e.preventDefault();
        onSubmit?.(e);
      }}
      style={{ ...font, display: "flex", flexDirection: "column", gap: "var(--vendo-density-content-gap, 10px)" }}
    >
      {children}
      <div>
        <Button type="submit" label={submitLabel} variant={submitVariant} disabled={disabled} />
      </div>
    </form>
  );
}

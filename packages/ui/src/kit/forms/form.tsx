/** Form — groups fields with a submit action (W2 §The Kit). */
import type { FormEvent, PropsWithChildren } from "react";
import { font } from "../tokens.js";
import { Button } from "./button.js";

export interface FormProps {
  /** Bound host-tool submit action (renderer-supplied). */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  submitLabel?: string;
  disabled?: boolean;
}

export function Form({ onSubmit, submitLabel = "Submit", disabled, children }: PropsWithChildren<FormProps>) {
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
        <Button type="submit" label={submitLabel} disabled={disabled} />
      </div>
    </form>
  );
}

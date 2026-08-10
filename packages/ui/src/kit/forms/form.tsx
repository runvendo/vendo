/** Form — groups fields with a submit action (W2 §The Kit). */
import { useRef, useState, type FormEvent, type PropsWithChildren } from "react";
import { font } from "../tokens.js";
import { Button, ConfirmDialog } from "./button.js";

export interface FormProps {
  /** Bound host-tool submit action (renderer-supplied). */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  submitLabel?: string;
  disabled?: boolean;
  /** Ask this before the submit action runs. */
  confirm?: string;
}

export function Form({ onSubmit, submitLabel = "Submit", disabled, confirm, children }: PropsWithChildren<FormProps>) {
  const [asking, setAsking] = useState(false);
  // The gate sits on the SUBMIT, not on the button: a form has more than one
  // way in (the submit press, Enter in a field, the jail's re-dispatched
  // submit — see tree/jail/runtime-entry.tsx), and a question every path but
  // one has to answer is not a question.
  const answered = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={form}
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
        if (confirm !== undefined && !answered.current) {
          setAsking(true);
          return;
        }
        answered.current = false;
        onSubmit?.(e);
      }}
      style={{ ...font, display: "flex", flexDirection: "column", gap: "var(--vendo-density-content-gap, 10px)" }}
    >
      {children}
      <div>
        <Button type="submit" label={submitLabel} disabled={disabled} />
      </div>
      {asking && confirm !== undefined ? (
        <ConfirmDialog
          question={confirm}
          label={submitLabel}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            // Back through the form's own submit, so the answered submission
            // takes the same path an unconfirmed one would have taken. A
            // script-dispatched submit rather than `requestSubmit()`: it
            // carries no native default action, so it reaches this handler
            // without ever touching the sandbox's blocked-submission path
            // (the same dispatch tree/jail/runtime-entry.tsx already relies on).
            answered.current = true;
            form.current?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          }}
        />
      ) : null}
    </form>
  );
}

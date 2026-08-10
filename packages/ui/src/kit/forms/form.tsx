/** Form — groups fields with a submit action (W2 §The Kit). */
import type { PropsWithChildren } from "react";
import { font } from "../tokens.js";
import { Button } from "./button.js";

/**
 * What a submitting Form hands its bound action: the values of its own NAMED
 * fields, exactly as the form is showing them.
 *
 * A class rather than a bare record because the renderer has to tell this apart
 * from the click event every other bound handler is called with, and sniffing an
 * object's shape for that is a guess (`tree/renderer.tsx`). Plain HTML
 * semantics: `name` maps a field onto a submit argument, and what submits is
 * what is on screen — no state slot, no change handler, nothing to seed.
 */
export class FormValues {
  constructor(readonly values: Readonly<Record<string, string>>) {}
}

export interface FormProps {
  /** Bound host-tool submit action (renderer-supplied). */
  onSubmit?: (values: FormValues) => void;
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
        const values: Record<string, string> = {};
        for (const [key, value] of new FormData(e.currentTarget).entries()) {
          if (typeof value === "string") values[key] = value;
        }
        onSubmit?.(new FormValues(values));
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

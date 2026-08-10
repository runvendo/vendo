/** Form — groups fields with a submit action (W2 §The Kit). */
import { useCallback, useState, type FormEvent, type PropsWithChildren } from "react";
import { font } from "../tokens.js";
import { Button } from "./button.js";
import { NothingToOfferContext } from "./field.js";

export interface FormProps {
  /** Bound host-tool submit action (renderer-supplied). */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  submitLabel?: string;
  disabled?: boolean;
}

export function Form({ onSubmit, submitLabel = "Submit", disabled, children }: PropsWithChildren<FormProps>) {
  /**
   * The fields inside this form that have nothing to offer — an empty dropdown is
   * the whole population today (`NothingToOfferContext`). While any of them is
   * empty there is nothing to submit, so this form OFFERS NO SUBMIT: the field
   * already states in words that there is nothing there, and a control that can
   * only fire its action with a missing argument is worse than no control.
   */
  const [barren, setBarren] = useState<readonly string[]>([]);
  const report = useCallback((fieldId: string, nothingToOffer: boolean) => {
    setBarren((current) => nothingToOffer
      ? (current.includes(fieldId) ? current : [...current, fieldId])
      : current.filter((id) => id !== fieldId));
  }, []);

  return (
    <NothingToOfferContext.Provider value={report}>
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
        {barren.length === 0 ? (
          <div>
            <Button type="submit" label={submitLabel} disabled={disabled} />
          </div>
        ) : null}
      </form>
    </NothingToOfferContext.Provider>
  );
}

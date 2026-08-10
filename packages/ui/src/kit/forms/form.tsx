/** Form — groups fields with a submit action (W2 §The Kit). */
import { useEffect, useRef, useState, type FormEvent, type PropsWithChildren } from "react";
import { font } from "../tokens.js";
import { Button } from "./button.js";

/**
 * A `<Select>` in this form that has nothing to choose — every option it
 * carries is a placeholder with an empty value, or it has no options at all,
 * because the query it lists came back empty.
 *
 * That is an argument which cannot exist yet, so the submit must not be
 * pressable: firing it sends the tool a call with the field simply missing
 * (`cancel_transfer {}` over an empty transfer list). Withholding is the
 * careful render, not a dead one — and it is derived, so nothing new is asked
 * of the writer. Scoped to Kit fields: DataTable's own filter dropdowns are
 * not arguments to anything.
 */
const nothingToChoose = (form: HTMLFormElement | null): boolean =>
  form !== null
  && [...form.querySelectorAll<HTMLSelectElement>('select[data-kit="Select"]')]
    .some((select) => [...select.options].every((option) => option.value === ""));

export interface FormProps {
  /** Bound host-tool submit action (renderer-supplied). */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  submitLabel?: string;
  disabled?: boolean;
}

export function Form({ onSubmit, submitLabel = "Submit", disabled, children }: PropsWithChildren<FormProps>) {
  // Read off the mounted fields, not the children elements: under the tree
  // renderer every child arrives wrapped, so a Select is never a recognisable
  // element here — but it is always a `<select>` in the DOM. The reading is
  // taken AFTER each commit, because a query that answers late replaces the
  // options, and a reading taken during that render would still be looking at
  // the empty list it is about to replace — a form disabled forever.
  const form = useRef<HTMLFormElement>(null);
  const [withheld, setWithheld] = useState(false);
  useEffect(() => {
    setWithheld(nothingToChoose(form.current));
  });
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
        onSubmit?.(e);
      }}
      style={{ ...font, display: "flex", flexDirection: "column", gap: "var(--vendo-density-content-gap, 10px)" }}
    >
      {children}
      <div>
        <Button type="submit" label={submitLabel} disabled={disabled === true || withheld} />
      </div>
    </form>
  );
}

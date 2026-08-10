/** Form — groups fields with a submit action (W2 §The Kit). */
import type { FormEvent, PropsWithChildren } from "react";
import type { Json } from "@vendoai/core";
import { font } from "../tokens.js";
import { Button } from "./button.js";

/** The fields a submit carries, branded so a change value or a click event can
 *  never be mistaken for an action payload (the renderer reads `$fields`). */
export interface SubmittedFields {
  $fields: Record<string, Json>;
}

/**
 * The named fields inside this form, as the object the submit tool's arguments
 * are. A field's `name` IS the argument it fills — before this, the Kit's
 * fields carried no `name` at all and `Form` handed the action nothing, so
 * `<Form onSubmit="cancel_transfer"><Select valueField="id"/></Form>` — the
 * shape every tool that acts on one row wants — called the tool with `{}`.
 *
 * An EMPTY value is left out rather than sent as `""`: an untouched field is
 * not a chosen one, and a tool that needs the argument should refuse the call
 * instead of acting on a blank. A checkbox is the exception — unchecked is a
 * real answer (`false`), not an absent one.
 */
function submittedFields(form: HTMLFormElement): Record<string, Json> {
  const fields: Record<string, Json> = {};
  for (const element of Array.from(form.elements)) {
    // tagName/type rather than `instanceof`: the Kit also runs inside the jail
    // iframe, whose element classes are a different realm's.
    const field = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (field.name === "") continue;
    if (field.tagName === "SELECT" && (field as HTMLSelectElement).multiple) {
      const chosen = Array.from((field as HTMLSelectElement).selectedOptions, (option) => option.value)
        .filter((value) => value !== "");
      if (chosen.length > 0) fields[field.name] = chosen;
      continue;
    }
    if (field.tagName === "INPUT" && field.type === "checkbox") {
      fields[field.name] = (field as HTMLInputElement).checked;
      continue;
    }
    if (field.tagName === "INPUT" && field.type === "number") {
      const asNumber = (field as HTMLInputElement).valueAsNumber;
      if (field.value !== "" && Number.isFinite(asNumber)) fields[field.name] = asNumber;
      continue;
    }
    if (field.value !== "") fields[field.name] = field.value;
  }
  return fields;
}

export interface FormProps {
  /** Bound host-tool submit action (renderer-supplied). The event stays first
   *  so an island handler written as `(e) => …` is unaffected; the fields ride
   *  second, where the renderer's bound action picks them up. */
  onSubmit?: (event: FormEvent<HTMLFormElement>, fields: SubmittedFields) => void;
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
        onSubmit?.(e, { $fields: submittedFields(e.currentTarget) });
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

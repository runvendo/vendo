/** Form — groups fields with a submit action (W2 §The Kit). */
import type { Json } from "@vendoai/core";
import type { FormEvent, PropsWithChildren } from "react";
import { font } from "../tokens.js";
import { Button } from "./button.js";

export interface FormProps {
  /** Bound host-tool submit action (renderer-supplied). */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  submitLabel?: string;
  disabled?: boolean;
}

/** The fields a submitted form carries, keyed by each control's `name` and
 *  coerced by the control's own declared type — a bound action's arguments are
 *  typed (`limit` is a number, a Checkbox is a boolean), and raw DOM strings
 *  would fail the tool's input schema. Controls with no `name` contribute
 *  nothing, exactly as a native submission treats them. Read by the bound
 *  `$action` closures (tree/renderer.tsx, tree/jail/runtime-entry.tsx), which
 *  are the only place a submit meets a host tool. */
export function submittedFields(form: HTMLFormElement): Record<string, Json> {
  const fields: Record<string, Json> = {};
  for (const element of Array.from(form.elements)) {
    const control = element as HTMLInputElement;
    if (!control.name || control.disabled) continue;
    if (control.tagName === "SELECT") {
      const select = element as HTMLSelectElement;
      fields[control.name] = select.multiple ? Array.from(select.selectedOptions, (o) => o.value) : select.value;
      continue;
    }
    if (control.type === "checkbox") {
      fields[control.name] = control.checked;
      continue;
    }
    if (control.type === "submit" || control.type === "button") continue;
    if (control.type === "number") {
      // An empty number field is absent, never 0 — a made-up amount is worse
      // than a rejected call.
      const parsed = Number(control.value);
      if (control.value !== "" && Number.isFinite(parsed)) fields[control.name] = parsed;
      continue;
    }
    fields[control.name] = control.value;
  }
  return fields;
}

/** The form behind a submit, or undefined for any other kind of argument — a
 *  click event, a changed value, whatever a generated island happens to pass. */
function submittedForm(arg: unknown): HTMLFormElement | undefined {
  if (arg === null || typeof arg !== "object") return undefined;
  const event = arg as { type?: unknown; currentTarget?: unknown };
  if (event.type !== "submit" || event.currentTarget === null || typeof event.currentTarget !== "object") return undefined;
  return "elements" in event.currentTarget ? (event.currentTarget as HTMLFormElement) : undefined;
}

/** A bound action's arguments: its static payload, with a submitted form's
 *  named fields laid over it. This is what makes `<Form onSubmit="a_tool">`
 *  carry its fields — the closure is the only place a press meets a host tool.
 *  A binding that is not a submit, or a form with no named field, keeps the
 *  payload it always had. */
export function actionArgs(payload: Json | undefined, arg: unknown): Json | undefined {
  const form = submittedForm(arg);
  if (form === undefined) return payload;
  const fields = submittedFields(form);
  if (Object.keys(fields).length === 0) return payload;
  const base = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
  return { ...base, ...fields };
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

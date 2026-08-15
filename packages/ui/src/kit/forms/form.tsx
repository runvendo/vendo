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
      {children}
      <div>
        <Button type="submit" label={submitLabel} disabled={disabled} />
      </div>
    </form>
  );
}

/** Shared field chrome (label + hint/error) for Kit form controls. */
import { useId, type PropsWithChildren, type ReactNode } from "react";
import { font, t } from "../tokens.js";

export function useFieldIds(prefix: string): { fieldId: string; helpId: string } {
  const id = useId().replace(/:/g, "");
  return { fieldId: `vendo-${prefix}-${id}`, helpId: `vendo-${prefix}-${id}-help` };
}

export interface FieldShellProps {
  fieldId: string;
  helpId: string;
  label?: string;
  hint?: string;
  error?: string;
  /** Render as a row (checkbox) rather than a stacked label. */
  inline?: boolean;
  labelNode?: ReactNode;
}

export function FieldShell({ fieldId, helpId, label, hint, error, inline, children }: PropsWithChildren<FieldShellProps>) {
  const message = error ?? hint;
  return (
    <div
      data-kit-field=""
      style={{
        ...font,
        display: "flex",
        flexDirection: inline ? "row" : "column",
        alignItems: inline ? "center" : "stretch",
        gap: inline ? "var(--vendo-density-inline-gap, 7px)" : "var(--vendo-density-field-gap, 6px)",
      }}
    >
      {label ? (
        <label htmlFor={fieldId} style={{ color: t.text, fontSize: "0.88em", fontWeight: 600, order: inline ? 2 : 0 }}>
          {label}
        </label>
      ) : null}
      {children}
      {message ? (
        <span id={helpId} style={{ color: error ? t.danger : t.muted, fontSize: "0.82em", lineHeight: 1.35 }}>
          {message}
        </span>
      ) : null}
    </div>
  );
}

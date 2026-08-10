/** Shared field chrome (label + hint/error) for Kit form controls. */
import { createContext, useContext, useEffect, useId, type PropsWithChildren, type ReactNode } from "react";
import { font, t } from "../tokens.js";

export function useFieldIds(prefix: string): { fieldId: string; helpId: string } {
  const id = useId().replace(/:/g, "");
  return { fieldId: `vendo-${prefix}-${id}`, helpId: `vendo-${prefix}-${id}-help` };
}

/**
 * A field with NOTHING TO OFFER, reaching the form that would submit it.
 *
 * A dropdown over an empty query holds no value, so the action it feeds cannot
 * run: genbench's `no-pending-transfers` (2026-08-10) shipped a green "Cancel
 * transfer" beside a blank select, and pressing it called
 * `cancel_transfer({})` — a control for rows that do not exist. The field is the
 * only part that knows its options are empty and the `Form` is the only part that
 * owns the submit, so the fact travels between them here rather than through a
 * rule the document's author has to remember.
 *
 * Undefined outside a `Form`: a standalone field has no submit to withhold.
 */
export const NothingToOfferContext =
  createContext<((fieldId: string, nothingToOffer: boolean) => void) | undefined>(undefined);

/** Report this field's emptiness to its form, and take it back on unmount. */
export function useReportNothingToOffer(fieldId: string, nothingToOffer: boolean): void {
  const report = useContext(NothingToOfferContext);
  useEffect(() => {
    report?.(fieldId, nothingToOffer);
    return () => report?.(fieldId, false);
  }, [report, fieldId, nothingToOffer]);
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

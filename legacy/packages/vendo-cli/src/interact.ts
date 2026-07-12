/**
 * The CLI's one and only seam onto an interactive terminal: masked text input
 * (for pasting a secret like an API key) and a checkbox-style multi-select
 * (for the component picker). Thin on purpose — no
 * business logic, no TTY/CI detection (that's `ui.ts`'s job; callers consult
 * it and decide whether to prompt at all before ever reaching this module).
 *
 * Cancellation (Ctrl-C, or any @clack/prompts "isCancel" result) collapses to
 * `null` for both methods. What `null` MEANS is a caller decision — e.g. init
 * might treat masked-input `null` the same as an empty string (skip), while a
 * picker might abort the whole step. This module doesn't know or care.
 */
import { isCancel, multiselect, password, type Option } from "@clack/prompts";

export interface MaskedInputOptions {
  /** The prompt message/question shown above the input. */
  message: string;
}

/** @clack/prompts' checkbox options are limited to primitive values. */
export type MultiSelectValue = string | number | boolean;

export interface MultiSelectItem<Value extends MultiSelectValue> {
  value: Value;
  label: string;
  /** One-line dim reason shown next to the option (e.g. why it's pre-checked). */
  hint?: string;
}

export interface MultiSelectOptions<Value extends MultiSelectValue> {
  message: string;
  options: MultiSelectItem<Value>[];
  /** Values pre-checked when the prompt opens. */
  initialValues?: Value[];
  /**
   * Whether at least one option must be checked to submit (forwarded to
   * clack; its default — required — applies when omitted). Pass `false` when
   * "chose nothing" is a legal answer, so it stays distinct from cancel
   * (Ctrl-C → `null`).
   */
  required?: boolean;
}

export interface Interactor {
  /** Prompts for masked (password-style) input. `null` on cancel. */
  maskedInput(opts: MaskedInputOptions): Promise<string | null>;
  /** Prompts for a checkbox multi-select. `null` on cancel. */
  multiSelect<Value extends MultiSelectValue>(opts: MultiSelectOptions<Value>): Promise<Value[] | null>;
}

/** The real implementation, backed by @clack/prompts. */
export function createInteractor(): Interactor {
  return {
    async maskedInput(opts) {
      const result = await password({ message: opts.message });
      return isCancel(result) ? null : result;
    },
    async multiSelect<Value extends MultiSelectValue>(opts: MultiSelectOptions<Value>) {
      // Cast through `Option<Value>` (not `unknown`): TS can't distribute the
      // conditional `Option<Value>` over a generic, unresolved `Value` even
      // though `Value extends MultiSelectValue` guarantees the shape below
      // matches at every concrete instantiation.
      const options = opts.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint })) as Option<Value>[];
      const result = await multiselect({
        message: opts.message,
        options,
        initialValues: opts.initialValues,
        required: opts.required,
      });
      return isCancel(result) ? null : result;
    },
  };
}

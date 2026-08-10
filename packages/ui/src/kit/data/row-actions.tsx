/**
 * Row-scoped controls for DataTable and CardList.
 *
 * The wire has no loop variable (see the unknown-reference message in the wire
 * compiler's expression parser), so "each pending row carries its own cancel"
 * cannot be written as a child — the iteration belongs to the component that
 * already iterates the rows. `args` values of the form `"$row.field"` are read
 * off the row the control sits on, so the call carries that row's id.
 */
import { Button } from "../forms/button.js";
import type { CSSProperties } from "react";

export interface RowAction {
  /** Control text. */
  label: string;
  /** The host tool this control runs. */
  tool: string;
  /** Tool arguments; a `"$row.field"` value reads that field off this row. */
  args?: Record<string, string | number | boolean>;
  variant?: "primary" | "secondary" | "danger";
  /** field → value (or values) deciding which rows get the control. */
  when?: Record<string, string | string[] | number | boolean>;
}

/** The guarded runner the tree renderer injects (`runAction` prop). */
export type RowActionRunner = (tool: string, args?: Record<string, unknown>) => unknown;

const at = (row: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), row);

const ROW_PREFIX = "$row.";

/** The row's arguments, or undefined when a `$row` field the call needs is
 *  missing — a control that cannot name its target is not rendered rather than
 *  pressed into a call with a hole in it. */
const argsFor = (row: Record<string, unknown>, args: RowAction["args"]): Record<string, unknown> | undefined => {
  const resolved: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args ?? {})) {
    if (typeof value === "string" && value.startsWith(ROW_PREFIX)) {
      const field = at(row, value.slice(ROW_PREFIX.length));
      if (field === undefined || field === null) return undefined;
      resolved[name] = field;
      continue;
    }
    resolved[name] = value;
  }
  return resolved;
};

const applies = (row: Record<string, unknown>, when: RowAction["when"]): boolean =>
  Object.entries(when ?? {}).every(([field, expected]) => {
    const actual = String(at(row, field) ?? "");
    return Array.isArray(expected)
      ? expected.some((option) => String(option) === actual)
      : String(expected) === actual;
  });

/** A row control is one line tall: the density vars the Kit's Button reads are
 *  overridden locally, so the row keeps its height and the button keeps the
 *  theme's tokens. */
const COMPACT = {
  display: "inline-flex",
  gap: "var(--vendo-density-inline-gap, 7px)",
  "--vendo-density-control-height": "26px",
  "--vendo-density-control-padding": "3px 9px",
} as CSSProperties;

export function RowActions({ row, actions, runAction }: {
  row: Record<string, unknown>;
  actions: readonly RowAction[];
  runAction?: RowActionRunner;
}) {
  // No runner (a Kit component used outside the tree renderer) means a press
  // could only be dead — render nothing instead.
  if (runAction === undefined) return null;
  const usable = actions.flatMap((action) => {
    if (!applies(row, action.when)) return [];
    const args = argsFor(row, action.args);
    return args === undefined ? [] : [{ action, args }];
  });
  if (usable.length === 0) return null;
  return (
    <span style={COMPACT}>
      {usable.map(({ action, args }) => (
        <Button
          key={`${action.tool}:${action.label}`}
          label={action.label}
          variant={action.variant ?? "secondary"}
          onClick={() => void runAction(action.tool, args)}
        />
      ))}
    </span>
  );
}

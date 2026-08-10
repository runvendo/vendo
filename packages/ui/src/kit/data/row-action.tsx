/**
 * The per-row action — the one way the Kit puts a control ON a row and gives
 * that control an argument.
 *
 * Every other Kit control names a bare tool: the spec's action prop is a plain
 * string and `bindValue` (tree/renderer.tsx) binds it to a ZERO-argument
 * closure, so the press arrives at the host as `{}`. A screen asked for "a way
 * to cancel one" therefore had to reach for a `<Form onSubmit="cancel_tool">`
 * over a `<Select>`, and every such press failed the host's schema on the
 * required id. A row action reads its arguments off the row it sits on instead.
 *
 * The key is `tool`, NOT `action`: convert-payload's `isActionProp` rewrites any
 * prop object carrying a string `action` into `{ $action }`, and `bindValue`
 * would then collapse this whole object into a bare closure, eating `label`.
 */
import { createContext, useContext } from "react";
import type { Json, ToolOutcome } from "@vendoai/core";
import { Button } from "../forms/button.js";

export interface KitRowAction {
  /** Names a host tool. */
  tool: string;
  label: string;
  /** Row fields to send as arguments (dot-paths allowed); defaults to `["id"]`. */
  args?: string[];
  variant?: "primary" | "secondary" | "danger";
  /** Show the control only on rows where `field` equals this value. */
  when?: { field: string; equals: string | number | boolean };
}

export type KitActionDispatcher = (name: string, args?: Json) => Promise<ToolOutcome>;

/**
 * The renderer's per-node action dispatch. `null` outside the tree walk —
 * code-land and in-jail mounts route their writes through `useToolAction` and
 * the frame bridge, so there is nothing here to press through; the control is
 * then not rendered at all, because a control that fires nothing is worse than
 * no control.
 */
export const KitActionDispatch = createContext<KitActionDispatcher | null>(null);

const resolvePath = (row: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>(
    (acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined),
    row,
  );

/** The arguments one press carries: each named field, read off THIS row. Only
 *  string/number/boolean survive — nothing else is a tool argument, and sending
 *  a nested object would fail the host's schema the way `{}` did. */
export function rowActionArgs(row: Record<string, unknown>, action: KitRowAction): Record<string, Json> {
  const args: Record<string, Json> = {};
  for (const path of action.args ?? ["id"]) {
    const value = resolvePath(row, path);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      args[path.split(".").pop() ?? path] = value;
    }
  }
  return args;
}

/** `when` compares the row's rendered-ish value as text, so "pending" matches a
 *  string, a number or a boolean field without the model having to know which. */
export function rowActionApplies(row: Record<string, unknown>, action: KitRowAction): boolean {
  if (action.when === undefined) return true;
  return String(resolvePath(row, action.when.field)) === String(action.when.equals);
}

export function RowActionButton({ row, action }: { row: Record<string, unknown>; action?: KitRowAction }) {
  const dispatch = useContext(KitActionDispatch);
  if (action === undefined || dispatch === null || !rowActionApplies(row, action)) return null;
  return (
    <Button
      label={action.label}
      variant={action.variant ?? "secondary"}
      onClick={() => {
        void dispatch(action.tool, rowActionArgs(row, action));
      }}
    />
  );
}

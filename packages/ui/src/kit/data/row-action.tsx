/**
 * The per-row action (W2 §The Kit) — the one action that carries ARGUMENTS.
 *
 * An `on*` prop names a tool and passes it nothing, so a mutation whose input
 * schema requires an id (`cancel_transfer{id}`) can only be wired where the id
 * is: on the row. The renderer binds `run` as a callback that takes its payload
 * at press time (tree/renderer.tsx `bindValue`), and `args` maps the TOOL's
 * argument name to the row field its value comes from.
 */
import type { Json } from "@vendoai/core";
import { Button } from "../forms/button.js";

export interface RowAction {
  /** Control label, e.g. "Cancel". */
  label?: string;
  /** Bound host-tool action (renderer-supplied), called with the row's args. */
  run?: (payload?: Json) => unknown;
  /** Tool argument name → row field key (dot-paths allowed). */
  args?: Record<string, string>;
  /** Defaults to `secondary`: the accent belongs to the screen's ONE primary
   *  action, not to a control repeated on every row. */
  variant?: "primary" | "secondary" | "danger";
}

const readPath = (row: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>(
    (acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined),
    row,
  );

export function RowActionButton({ action, row }: { action: RowAction; row: Record<string, unknown> }) {
  return (
    <Button
      label={action.label ?? "Run"}
      variant={action.variant ?? "secondary"}
      onClick={() => {
        void action.run?.(Object.fromEntries(
          Object.entries(action.args ?? {}).map(([argument, key]) => [argument, readPath(row, key) as Json]),
        ));
      }}
    />
  );
}

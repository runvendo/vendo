/**
 * TableRow — one DataTable row the model painted itself.
 *
 * A `field` binding has nowhere to put arithmetic: `<Money field="balance_cents"/>`
 * reads cents and prints them as dollars, and no prop on the column can divide
 * by 100. A row written as CHILDREN can, because the math runs in the screen VM
 * before the element is ever serialized — `<Money amount={a.balance_cents/100}/>`
 * — and for the same reason a cell may hold a control with a row to act on.
 *
 * A row's children ARE its cells, one per column, exactly as a tab's child is
 * its panel (feedback/tabs.tsx) and a menu's child is one item (feedback/menu.tsx).
 * There is no Cell component: several components in one cell go in a <Stack>.
 */
import { Children, useContext, type ReactNode } from "react";
import { alignCss, cellPad, foldStyle, headerText, TableContext } from "./data-table.js";
import { type KitStyled } from "../tokens.js";

export interface TableRowProps extends KitStyled {
  /** One element per column, in column order. */
  children?: ReactNode;
}

export function TableRow({ children, style }: TableRowProps) {
  const table = useContext(TableContext);
  const columns = table?.columns ?? [];
  const cells = Children.toArray(children);
  // Outside a DataTable there are no columns to place cells against, and no
  // fold — the children themselves say how many cells there are.
  const visible = table?.visible ?? cells.length;
  /**
   * A cell per COLUMN, not per child: a row that was written short still
   * occupies the whole grid, so one missing cell cannot slide the rest of the
   * row out from under its headers. And never zero — a row that paints nothing
   * is not a row, it is a component that vanished when used alone.
   */
  const painted = Math.max(visible, 1);
  return (
    <>
      {Array.from({ length: painted }, (_unused, i) => (
        // A row generates no box of its own — its cells ARE the row, so `style`
        // dresses each of them.
        <td key={i} style={{ padding: cellPad, textAlign: alignCss(columns[i]?.align), ...style }}>
          {cells[i]}
          {/* DataTable folds the columns past the surface width into the first
              cell, and cannot reach into a model-built row to do it — so the
              row folds its own, off the same count and the same labels. */}
          {i === 0 && visible < columns.length ? (
            <div style={foldStyle}>
              {columns.slice(visible).map((col, j) => {
                // An action column has no label to name it by, and a bare
                // "Checking: Cancel" reads as the row's own value.
                const label = headerText(col);
                return <span key={j}>{label === "" ? null : `${label}: `}{cells[visible + j]}</span>;
              })}
            </div>
          ) : null}
        </td>
      ))}
    </>
  );
}

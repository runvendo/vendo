/**
 * TableRow — one DataTable row the model painted itself.
 *
 * A whole row written by hand, where a `cell` function per column would be three
 * functions saying the same thing: the math and the formatting run in the screen
 * VM before the element is ever serialized —
 * `<Text>{(a.balance_cents / 100).toLocaleString("en-US", { style: "currency",
 * currency: "USD" })}</Text>` — and a cell may hold a control with that row to
 * act on.
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
  // Outside a DataTable there are no columns to place cells against and nothing
  // dropped — the children themselves say how many cells there are.
  const places = Array.from({ length: table === undefined ? cells.length : columns.length }, (_unused, i) => i);
  /**
   * A cell per COLUMN the table kept, not per child: a row that was written short
   * still occupies the whole grid, so one missing cell cannot slide the rest of
   * the row out from under its headers. A dropped column is addressed by its own
   * INDEX for the same reason — the columns that give way are the least important
   * ones wherever they sit, so the kept ones are not a prefix and counting them
   * would put every later cell one column off.
   *
   * And never zero — a row that paints nothing is not a row, it is a component
   * that vanished when used alone.
   */
  const kept = places.filter((i) => table?.dropped.has(i) !== true);
  /** The columns that went, when the table asked for them back as lines. */
  const hidden = table?.fold === true ? places.filter((i) => table.dropped.has(i)) : [];
  return (
    <>
      {(kept.length > 0 ? kept : [0]).map((column, i) => (
        // A row generates no box of its own — its cells ARE the row, so `style`
        // dresses each of them.
        <td key={column} style={{ padding: cellPad, textAlign: alignCss(columns[column]?.align), ...style }}>
          {cells[column]}
          {/* DataTable folds the columns it had no room for into the first cell,
              and cannot reach into a model-built row to do it — so the row folds
              its own, off the same set and the same labels. */}
          {i === 0 && hidden.length > 0 ? (
            <div style={foldStyle}>
              {hidden.map((other) => {
                // An action column has no label to name it by, and a bare
                // "Checking: Cancel" reads as the row's own value.
                const label = headerText(columns[other]!);
                return <span key={other}>{label === "" ? null : `${label}: `}{cells[other]}</span>;
              })}
            </div>
          ) : null}
        </td>
      ))}
    </>
  );
}

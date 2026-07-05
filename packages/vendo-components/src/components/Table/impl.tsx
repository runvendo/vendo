import {
  Table as UITable,
  TableHeader as UITableHeader,
  TableBody as UITableBody,
  TableRow as UITableRow,
  TableHead as UITableHead,
  TableCell as UITableCell,
} from "../../openui.js";
import { createPrewiredImpl } from "../../impl-helpers/create-impl.js";
import { tableSchema } from "./descriptor.js";

/** A cell renders scalars; nested values (raw tool rows carry them) show as
 *  an em dash rather than JSON noise or a whole-table validation failure. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "—";
}

export const Table = createPrewiredImpl(tableSchema, (p) => (
  <UITable>
    {p.caption ? <caption>{p.caption}</caption> : null}
    <UITableHeader>
      <UITableRow>
        {p.columns.map((col) => (
          <UITableHead key={col.key}>{col.label}</UITableHead>
        ))}
      </UITableRow>
    </UITableHeader>
    <UITableBody>
      {p.rows.map((row, i) => (
        <UITableRow key={i}>
          {p.columns.map((col) => (
            <UITableCell key={col.key}>{cellText(row[col.key])}</UITableCell>
          ))}
        </UITableRow>
      ))}
    </UITableBody>
  </UITable>
));

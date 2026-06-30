import {
  Table as UITable,
  TableHeader as UITableHeader,
  TableBody as UITableBody,
  TableRow as UITableRow,
  TableHead as UITableHead,
  TableCell as UITableCell,
} from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { tableSchema } from "./descriptor";

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
            <UITableCell key={col.key}>{String(row[col.key] ?? "")}</UITableCell>
          ))}
        </UITableRow>
      ))}
    </UITableBody>
  </UITable>
));

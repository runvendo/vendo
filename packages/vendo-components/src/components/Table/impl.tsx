import {
  Table as UITable,
  TableHeader as UITableHeader,
  TableBody as UITableBody,
  TableRow as UITableRow,
  TableHead as UITableHead,
  TableCell as UITableCell,
} from "../../openui.js";
import type { FieldFormat } from "@vendoai/core";
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

// The cents rule promises "$" rendering (core FORMAT_RULES: 4018 → $40.18),
// so the deterministic renderer matches it: en-US USD. Hosts with another
// currency need a new FieldFormat value, not a different reading of `cents`.
const centsFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const isoDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** Apply a column's declared FieldFormat to a RAW cell value. Only values of
 *  the format's expected shape are converted — anything else (e.g. a string
 *  the authoring model already formatted) falls through to `cellText`, so a
 *  format can never mangle an already-displayable cell. */
function formatCell(value: unknown, format: FieldFormat | undefined): string {
  switch (format) {
    case "cents":
      if (typeof value === "number" && Number.isFinite(value)) {
        return centsFormatter.format(value / 100);
      }
      break;
    case "percent":
      if (typeof value === "number" && Number.isFinite(value)) return `${value}%`;
      break;
    case "iso-date": {
      // Render the literal day the string names — built from its own Y/M/D
      // parts, never a timezone-shifting Date parse.
      const parts = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (parts) {
        return isoDateFormatter.format(
          new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))),
        );
      }
      break;
    }
    case "iso-datetime":
      if (typeof value === "string") {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleDateString("en-US");
      }
      break;
  }
  return cellText(value);
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
            <UITableCell key={col.key}>{formatCell(row[col.key], col.format)}</UITableCell>
          ))}
        </UITableRow>
      ))}
    </UITableBody>
  </UITable>
));

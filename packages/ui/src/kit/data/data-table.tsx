/**
 * DataTable — the flagship (W2 §The Kit). TanStack Table internals; the model
 * only fills props. It sorts, filters, searches, paginates, resolves dot-path
 * column keys, formats each cell by its `format` token, and shows a named-query
 * empty state — none of which the model has to author.
 */
import { useMemo, useState, type CSSProperties } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { applyFormat, type ValueFormat } from "../format.js";
import { font, t } from "../tokens.js";
import { humanizeEnum } from "../values.js";

export interface DataTableColumn {
  /** Field key; supports dot-paths ("client.name"). */
  key: string;
  /** Header label; defaults to a humanized last path segment. */
  label?: string;
  /** Value-tier format applied to every cell. */
  format?: ValueFormat;
  align?: "start" | "center" | "end";
}

export interface DataTableProps {
  /** Rows from a tool call. */
  rows: Array<Record<string, unknown>>;
  /** Column descriptions; when omitted, inferred from the first row's keys. */
  columns?: DataTableColumn[];
  /** Initial sort, e.g. "dueDate asc" or "amountCents desc". */
  sortBy?: string;
  /** Hard cap on rows shown. */
  limit?: number;
  /** Column keys to expose as distinct-value filter dropdowns. */
  filterableBy?: string[];
  /** Show a search box filtering across all columns. */
  searchable?: boolean;
  /** Page size; enables pagination when set. */
  paginate?: number;
  /** Text shown when there are no rows (the named-query empty state). */
  emptyState?: string;
  /** Optional table caption. */
  caption?: string;
}

/** Resolve a dot-path against a row. */
function resolvePath(row: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, row);
}

const alignCss = (a: DataTableColumn["align"]): CSSProperties["textAlign"] =>
  a === "end" ? "right" : a === "center" ? "center" : "left";

const cellPad = "var(--vendo-density-table-padding, 10px 12px)";

export function DataTable(props: DataTableProps) {
  const {
    rows: rawRows,
    sortBy,
    limit,
    filterableBy,
    searchable = false,
    paginate,
    emptyState = "No data",
    caption,
  } = props;

  // W3 — fail SOFT on missing data: a failed/pending query resolves its
  // binding to undefined at runtime; the table's named-query empty state is
  // the honest render, never a crash.
  const rows = useMemo<Array<Record<string, unknown>>>(
    () => (Array.isArray(rawRows) ? rawRows : []),
    [rawRows],
  );

  const columns = useMemo<DataTableColumn[]>(
    () => props.columns ?? Object.keys(rows[0] ?? {}).map((key) => ({ key })),
    [props.columns, rows],
  );

  const data = useMemo(
    () => (typeof limit === "number" && limit >= 0 ? rows.slice(0, limit) : rows),
    [rows, limit],
  );

  const initialSorting = useMemo<SortingState>(() => {
    if (!sortBy) return [];
    const [id, dir] = sortBy.trim().split(/\s+/);
    if (!id) return [];
    return [{ id, desc: (dir ?? "asc").toLowerCase() === "desc" }];
  }, [sortBy]);

  const tanstackColumns = useMemo<Array<ColumnDef<Record<string, unknown>>>>(
    () =>
      columns.map((col) => ({
        id: col.key,
        accessorFn: (row) => resolvePath(row, col.key),
        header: col.label ?? humanizeEnum(col.key.split(".").pop() ?? col.key),
        cell: (ctx) => {
          const raw = ctx.getValue();
          const formatted = applyFormat(raw, col.format ?? "text");
          if (formatted === null) return <span style={{ color: t.muted }}>—</span>;
          return formatted;
        },
        filterFn: "includesString",
      })),
    [columns],
  );

  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<Array<{ id: string; value: string }>>([]);

  const table = useReactTable({
    data,
    columns: tanstackColumns,
    state: { sorting, globalFilter, columnFilters },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters as never,
    globalFilterFn: "includesString",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    ...(typeof paginate === "number" && paginate > 0
      ? { getPaginationRowModel: getPaginationRowModel(), initialState: { pagination: { pageSize: paginate, pageIndex: 0 } } }
      : {}),
  });

  const distinctValues = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const key of filterableBy ?? []) {
      const set = new Set<string>();
      for (const row of data) {
        const v = resolvePath(row, key);
        if (v !== null && v !== undefined && v !== "") set.add(String(v));
      }
      map.set(key, [...set].sort());
    }
    return map;
  }, [filterableBy, data]);

  const columnLabel = (key: string) =>
    columns.find((c) => c.key === key)?.label ?? humanizeEnum(key.split(".").pop() ?? key);

  const bodyRows = table.getRowModel().rows;

  return (
    <div data-kit="DataTable" style={{ ...font, display: "flex", flexDirection: "column", gap: "var(--vendo-density-content-gap, 10px)" }}>
      {(searchable || (filterableBy && filterableBy.length > 0)) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--vendo-density-inline-gap, 7px)", alignItems: "center" }}>
          {searchable && (
            <input
              type="search"
              role="searchbox"
              aria-label="Search table"
              placeholder="Search…"
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              style={{
                ...font,
                minHeight: "var(--vendo-density-control-height, 38px)",
                border: `1px solid ${t.border}`,
                borderRadius: t.radiusSmall,
                background: t.surface,
                padding: "var(--vendo-density-control-padding, 9px 12px)",
                flex: "1 1 180px",
              }}
            />
          )}
          {(filterableBy ?? []).map((key) => (
            <select
              key={key}
              aria-label={`Filter by ${columnLabel(key)}`}
              value={columnFilters.find((f) => f.id === key)?.value ?? ""}
              onChange={(e) => {
                const value = e.target.value;
                setColumnFilters((prev) => {
                  const rest = prev.filter((f) => f.id !== key);
                  return value ? [...rest, { id: key, value }] : rest;
                });
              }}
              style={{
                ...font,
                minHeight: "var(--vendo-density-control-height, 38px)",
                border: `1px solid ${t.border}`,
                borderRadius: t.radiusSmall,
                background: t.surface,
                padding: "6px 10px",
                cursor: "pointer",
              }}
            >
              <option value="">All {columnLabel(key)}</option>
              {(distinctValues.get(key) ?? []).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ))}
        </div>
      )}

      <div
        style={{
          width: "100%",
          overflowX: "auto",
          border: `1px solid ${t.border}`,
          borderRadius: t.radiusMedium,
          background: t.surface,
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          {caption ? (
            <caption style={{ padding: cellPad, textAlign: "left", fontWeight: 650 }}>{caption}</caption>
          ) : null}
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} style={{ background: `color-mix(in srgb, ${t.background} 72%, ${t.surface})` }}>
                {hg.headers.map((header) => {
                  const col = columns.find((c) => c.key === header.column.id);
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      onClick={header.column.getToggleSortingHandler()}
                      style={{
                        color: t.muted,
                        borderBottom: `1px solid ${t.border}`,
                        fontSize: "0.78em",
                        fontWeight: 700,
                        letterSpacing: "0.045em",
                        padding: cellPad,
                        textAlign: alignCss(col?.align),
                        textTransform: "uppercase",
                        cursor: "pointer",
                        userSelect: "none",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {sorted === "asc" ? " ▲" : sorted === "desc" ? " ▼" : ""}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {bodyRows.length === 0 ? (
              <tr>
                <td
                  colSpan={Math.max(1, columns.length)}
                  style={{ color: t.muted, padding: "calc(var(--vendo-font-size, 15px) * 1.6) 12px", textAlign: "center" }}
                >
                  {emptyState}
                </td>
              </tr>
            ) : (
              bodyRows.map((row, rowIndex) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => {
                    const col = columns.find((c) => c.key === cell.column.id);
                    return (
                      <td
                        key={cell.id}
                        style={{
                          borderBottom: rowIndex === bodyRows.length - 1 ? 0 : `1px solid ${t.border}`,
                          padding: cellPad,
                          textAlign: alignCss(col?.align),
                          fontVariantNumeric: col?.format && col.format !== "text" ? "tabular-nums" : undefined,
                        }}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {typeof paginate === "number" && paginate > 0 && table.getPageCount() > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--vendo-density-inline-gap, 7px)" }}>
          <span style={{ color: t.muted, fontSize: "0.85em" }}>
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
          </span>
          <div style={{ display: "flex", gap: "var(--vendo-density-inline-gap, 7px)" }}>
            <PageButton disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
              Previous
            </PageButton>
            <PageButton disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
              Next
            </PageButton>
          </div>
        </div>
      )}
    </div>
  );
}

function PageButton({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        ...font,
        border: `1px solid ${t.border}`,
        borderRadius: t.radiusSmall,
        background: t.surface,
        color: t.text,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontSize: "0.85em",
        fontWeight: 600,
        padding: "6px 12px",
      }}
    >
      {children}
    </button>
  );
}

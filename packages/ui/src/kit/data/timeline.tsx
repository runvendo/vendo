/** Timeline — a record history down a spine, dot-marked (W2 §The Kit). */
import type { ReactNode } from "react";
import { EmptyOrForming } from "../../tree/forming-skeleton.js";
import { applyFormat } from "../format.js";
import { readField, RowContext } from "../row.js";
import { font, hairline, microLabel, numeric, t, type KitStyled } from "../tokens.js";

export interface TimelineProps extends KitStyled {
  /** Entries from a tool call, in the order they should read. */
  entries: Array<Record<string, unknown>>;
  /** Field for each entry's title. */
  titleField?: string;
  /** Field holding each entry's timestamp. */
  timeField?: string;
  /** Where the timestamp sits: leading the title, or right-aligned. */
  timeAlign?: "start" | "end";
  /** Kit elements rendered as each entry's BODY instead of the title, with that
   *  entry published on `RowContext` so the components inside name their field
   *  — the DataTable cell contract, once per entry. */
  cell?: ReactNode;
  /** Kit element drawn in place of the dot. */
  marker?: ReactNode;
  /** Text shown when there are no entries. */
  emptyState?: string;
  /** Kit elements shown in place of `emptyState` when there are no entries. */
  empty?: ReactNode;
}

/** A timestamp field is a date most of the time and a plain label the rest of
 *  it; an unformattable value reads as itself rather than disappearing. */
function timeText(value: unknown): string {
  return applyFormat(value, "datetime") ?? (value === undefined || value === null ? "" : String(value));
}

export function Timeline({
  entries: rawEntries,
  titleField,
  timeField,
  timeAlign = "start",
  cell,
  marker,
  emptyState = "No activity",
  empty,
  style,
}: TimelineProps) {
  // W3 — fail SOFT on missing data (a failed query resolves to undefined).
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  if (entries.length === 0) {
    // The slot replaces the dashed box, not its TEXT — see CardList.
    return empty !== undefined ? <div data-kit="Timeline" style={style}><EmptyOrForming>{empty}</EmptyOrForming></div> : (
      <div
        data-kit="Timeline"
        style={{
          ...font,
          color: t.muted,
          textAlign: "center",
          border: `${t.borderWidth} dashed ${t.border}`,
          borderRadius: t.radiusMedium,
          padding: "calc(var(--vendo-font-size, 15px) * 1.6)",
          ...style,
        }}
      >
        <EmptyOrForming>{emptyState}</EmptyOrForming>
      </div>
    );
  }
  return (
    <ol
      data-kit="Timeline"
      style={{ ...font, display: "flex", flexDirection: "column", listStyle: "none", margin: 0, padding: 0, ...style }}
    >
      {entries.map((entry, index) => {
        const time = timeField === undefined ? "" : timeText(readField(entry, timeField));
        const title = titleField === undefined ? null : String(readField(entry, titleField) ?? "—");
        return (
          <RowContext.Provider key={String(readField(entry, "id") ?? index)} value={entry}>
            <li style={{ display: "flex", gap: "var(--vendo-density-content-gap, 10px)", minWidth: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                {marker ?? (
                  <span
                    aria-hidden="true"
                    style={{
                      width: 9,
                      height: 9,
                      marginTop: "0.45em",
                      borderRadius: "50%",
                      background: t.accent,
                      boxShadow: `0 0 0 calc(${t.borderWidth} * 3) color-mix(in srgb, ${t.accent} 14%, transparent)`,
                    }}
                  />
                )}
                {/* The spine joins this entry to the next, so the last one ends
                    at its dot instead of trailing a stub. */}
                {index < entries.length - 1 ? (
                  <span style={{ flex: 1, marginTop: 5, borderLeft: hairline }} />
                ) : null}
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: timeAlign === "end" ? "row" : "column",
                  justifyContent: "space-between",
                  alignItems: timeAlign === "end" ? "baseline" : "stretch",
                  gap: timeAlign === "end" ? "var(--vendo-density-content-gap, 10px)" : 2,
                  flex: 1,
                  minWidth: 0,
                  paddingBottom: index === entries.length - 1 ? 0 : "var(--vendo-density-content-gap, 10px)",
                }}
              >
                {timeAlign === "start" && time ? <TimeText time={time} /> : null}
                <div style={{ minWidth: 0, fontWeight: t.weightEmphasis, lineHeight: 1.4 }}>{cell ?? title}</div>
                {timeAlign === "end" && time ? <TimeText time={time} /> : null}
              </div>
            </li>
          </RowContext.Provider>
        );
      })}
    </ol>
  );
}

function TimeText({ time }: { time: string }) {
  return (
    <span style={{ ...microLabel, ...numeric, flexShrink: 0, whiteSpace: "nowrap" }}>{time}</span>
  );
}

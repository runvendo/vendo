/**
 * Calendar — a month as a grid, with each item sitting on its own day
 * (W2 §The Kit).
 *
 * The Kit could lay records out in every order but the one a person reads a
 * month in: asked for bills "laid out like a calendar", a screen had to
 * disclaim the grid and fall back to a Timeline. This is that grid — the
 * DAY-shaped view of `items`, beside CardList's card-shaped one and DataTable's
 * row-shaped one, and it reads its fields exactly as they do.
 */
import { applyFormat, getKitIntl } from "../format.js";
import { readField } from "../row.js";
import { font, hairline, microLabel, numeric, resolveTone, t, toneStyle, type KitTone } from "../tokens.js";
import { humanizeEnum } from "../values.js";

export interface CalendarProps {
  /** Items from a tool call. */
  items: Array<Record<string, unknown>>;
  /** Field holding the day each item falls on (ISO date or datetime). */
  dateField?: string;
  /** Field for each item's label. */
  titleField?: string;
  /** Field holding each item's amount in MAJOR units — a cents field is divided
   *  by 100 where it is read, as everywhere in the Kit. */
  amountField?: string;
  /** Field whose value labels and tones each item. */
  statusField?: string;
  /** Status value → tone, exactly as EnumBadge takes it. */
  tones?: Record<string, KitTone>;
  /** The month to lay out, as ISO `yyyy-mm`; defaults to the earliest item's. */
  month?: string;
}

/** UTC throughout: a local-midnight Date shifts the day west of Greenwich. */
const isoOf = (date: Date): string => date.toISOString().slice(0, 10);

/** An item's day. An ISO string is taken at its face — the day the host wrote,
 *  not the day a local-midnight Date would slip it to. */
const dayOf = (value: unknown): string | null => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/u.test(value)) return value.slice(0, 10);
  const at = value instanceof Date || typeof value === "number" ? new Date(value) : null;
  return at === null || Number.isNaN(at.getTime()) ? null : isoOf(at);
};

/** The first of the month an ISO `yyyy-mm`, day or timestamp names — this month
 *  when it names nothing, so an empty calendar still draws the month asked for. */
const monthOf = (value: string | undefined): Date => {
  const at = value === undefined ? Number.NaN : Date.parse(`${value.slice(0, 7)}-01T00:00:00Z`);
  return Number.isNaN(at) ? new Date() : new Date(at);
};

/** The month's weeks, whole: every row is seven days, so the leading and
 *  trailing days belong to the neighbouring months and are drawn muted. */
const weeksOf = (month: Date): Date[][] => {
  const year = month.getUTCFullYear();
  const index = month.getUTCMonth();
  const lead = new Date(Date.UTC(year, index, 1)).getUTCDay();
  const rows = Math.ceil((lead + new Date(Date.UTC(year, index + 1, 0)).getUTCDate()) / 7);
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: 7 }, (_, day) => new Date(Date.UTC(year, index, day + row * 7 + 1 - lead))));
};

const label = (date: Date, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(getKitIntl().locale, { ...options, timeZone: "UTC" }).format(date);

/** Sunday-first weekday initials in the host's locale (Jan 2024 opens on one),
 *  resolved at render: the provider installs that locale after this module
 *  loads. */
const weekdays = (): string[] =>
  Array.from({ length: 7 }, (_, i) => label(new Date(Date.UTC(2024, 0, 7 + i)), { weekday: "narrow" }));

/** `Object.hasOwn`, not a bare index: a status of "constructor" is a string too. */
const toneFor = (tones: Record<string, KitTone> | undefined, status: string): KitTone =>
  resolveTone(tones !== undefined && Object.hasOwn(tones, status) ? tones[status] : undefined);

export function Calendar({ items: rawItems, dateField, titleField, amountField, statusField, tones, month }: CalendarProps) {
  // W3 — fail SOFT on missing data (a failed query resolves to undefined).
  const items = Array.isArray(rawItems) ? rawItems : [];
  const byDay = new Map<string, Array<Record<string, unknown>>>();
  for (const item of items) {
    const day = dateField === undefined ? null : dayOf(readField(item, dateField));
    if (day !== null) byDay.set(day, [...(byDay.get(day) ?? []), item]);
  }
  const shown = monthOf(month ?? [...byDay.keys()].sort()[0]);
  return (
    <div
      data-kit="Calendar"
      style={{ ...font, border: hairline, borderRadius: t.radiusMedium, background: t.surface, overflow: "hidden" }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <caption style={{ ...microLabel, padding: "var(--vendo-density-table-padding, 10px 12px)", textAlign: "start" }}>
          {label(shown, { month: "long", year: "numeric" })}
        </caption>
        <thead>
          <tr style={{ background: t.surfaceRaised }}>
            {weekdays().map((day, index) => (
              <th key={index} scope="col" style={{ ...microLabel, borderBottom: hairline, padding: "5px 0", textAlign: "center" }}>
                {day}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeksOf(shown).map((week, row) => (
            <tr key={row}>
              {week.map((date, index) => {
                const day = isoOf(date);
                const outside = date.getUTCMonth() !== shown.getUTCMonth();
                return (
                  <td
                    key={day}
                    data-day={day}
                    style={{
                      borderTop: hairline,
                      // Collapsed borders draw the grid; the first cell leaves
                      // its left edge to the container, which already has one.
                      borderInlineStart: index === 0 ? undefined : hairline,
                      background: outside ? t.surfaceRaised : undefined,
                      padding: 2,
                      verticalAlign: "top",
                    }}
                  >
                    <div style={{ ...microLabel, ...numeric, color: outside ? t.muted : t.text, textAlign: "center" }}>
                      {date.getUTCDate()}
                    </div>
                    {(byDay.get(day) ?? []).map((item, n) => (
                      <Entry
                        key={n}
                        item={item}
                        titleField={titleField}
                        amountField={amountField}
                        statusField={statusField}
                        tones={tones}
                      />
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One item in its day's cell: label, amount, status — stacked, because a day
 *  cell is a seventh of the width and nothing fits beside anything. */
function Entry({
  item,
  titleField,
  amountField,
  statusField,
  tones,
}: Pick<CalendarProps, "titleField" | "amountField" | "statusField" | "tones"> & { item: Record<string, unknown> }) {
  const status = statusField === undefined ? null : applyFormat(readField(item, statusField), "text");
  const amount = amountField === undefined ? null : applyFormat(readField(item, amountField), "money");
  const paint = toneStyle[toneFor(tones, status ?? "")];
  return (
    <div
      style={{
        border: `${t.borderWidth} solid ${paint.border}`,
        borderRadius: t.radiusSmall,
        background: paint.background,
        color: paint.color,
        fontSize: "0.7em",
        lineHeight: 1.3,
        marginTop: 2,
        // A label is a merchant's name, not a word: it wraps rather than
        // truncating, because a clipped name identifies nothing.
        overflowWrap: "break-word",
        padding: "2px 3px",
      }}
    >
      {titleField === undefined ? null : (
        <div style={{ fontWeight: t.weightEmphasis }}>{String(readField(item, titleField) ?? "—")}</div>
      )}
      {amount === null ? null : <div style={numeric}>{amount}</div>}
      {status === null ? null : <div style={{ opacity: 0.75 }}>{humanizeEnum(status)}</div>}
    </div>
  );
}

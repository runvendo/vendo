/**
 * DateRange — a start and an end picked from one calendar (W2 §The Kit).
 *
 * Base UI ships no calendar, so the grid is ours; what it borrows is the
 * popover — anchoring, dismissal, Esc, and focus return — which is the part
 * that is actually hard to get right.
 */
import { Popover } from "@base-ui/react/popover";
import { useState, type ComponentProps } from "react";
import { applyFormat, getKitIntl } from "../format.js";
import { control, font, microLabel, popup, popupMotion, t, transitionFor, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { FieldShell, useFieldIds } from "./field.js";

interface DateRangeOwnProps extends KitStyled {
  label?: string;
  /** ISO yyyy-mm-dd. */
  start?: string;
  end?: string;
  min?: string;
  max?: string;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  /** Bound change handler; receives `{ start, end }` as ISO dates. */
  onChange?: (range: { start: string; end: string }) => void;
}

/** Plus any Base UI `<Popover.Root>` prop, handed straight to the popover.
 *  `style` stays the Kit's own — it dresses the ROOT the label and hint share. */
export type DateRangeProps = DateRangeOwnProps & KitEngine<ComponentProps<typeof Popover.Root>, DateRangeOwnProps>;

/** UTC throughout: a local-midnight Date shifts the day west of Greenwich. */
const iso = (date: Date): string => date.toISOString().slice(0, 10);

const parse = (value: string | undefined): Date | null => {
  const at = value === undefined ? Number.NaN : Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(at) ? null : new Date(at);
};

/** The month's days, padded with the blanks its first weekday leaves. */
const gridOf = (month: Date): Array<Date | null> => {
  const year = month.getUTCFullYear();
  const index = month.getUTCMonth();
  const days: Array<Date | null> = Array.from({ length: new Date(Date.UTC(year, index, 1)).getUTCDay() }, () => null);
  for (let day = 1; day <= new Date(Date.UTC(year, index + 1, 0)).getUTCDate(); day += 1) {
    days.push(new Date(Date.UTC(year, index, day)));
  }
  return days;
};

const label = (date: Date, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(getKitIntl().locale, { ...options, timeZone: "UTC" }).format(date);

/** Sunday-first weekday initials, in the host's locale. Jan 2024 opens on one. */
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => label(new Date(Date.UTC(2024, 0, 7 + i)), { weekday: "narrow" }));

export function DateRange({ label: fieldLabel, start, end, min, max, placeholder = "Pick a range", hint, disabled, onChange, style, children, pending, ...engine }: DateRangeProps & KitRendered) {
  const { fieldId, helpId } = useFieldIds("date-range");
  const [month, setMonth] = useState(() => parse(start) ?? new Date());
  // The half-made range: set on the first click, cleared by the second — or by
  // walking away. A pending anchor that survived dismissal made the NEXT click,
  // in a reopened calendar, the endpoint of a range the person had abandoned,
  // and fired it as a real answer.
  const [anchor, setAnchor] = useState<string | undefined>(undefined);

  const pick = (day: string) => {
    if (anchor === undefined) {
      setAnchor(day);
      return;
    }
    setAnchor(undefined);
    onChange?.(anchor <= day ? { start: anchor, end: day } : { start: day, end: anchor });
  };

  const from = anchor ?? start;
  const to = anchor === undefined ? end : anchor;
  const shown = `${applyFormat(start, "date") ?? ""}${end ? ` – ${applyFormat(end, "date")}` : ""}`;

  return (
    <FieldShell fieldId={fieldId} helpId={helpId} label={fieldLabel} hint={hint} style={style}>
      <Popover.Root {...given(engine)} onOpenChange={(next) => { if (!next) setAnchor(undefined); }}>
        <Popover.Trigger
          id={fieldId}
          data-kit="DateRange"
          disabled={disabled}
          aria-describedby={hint ? helpId : undefined}
          style={{ ...control, color: shown ? t.text : t.muted, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, textAlign: "start" }}
        >
          {shown || placeholder}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner sideOffset={4} style={{ zIndex: 2 }}>
            <Popover.Popup style={(state) => ({ ...popup, ...popupMotion(state), padding: 10 })}>
              <div style={{ ...font, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, paddingBottom: 6 }}>
                <button type="button" aria-label="Previous month" onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)))} style={stepStyle}>‹</button>
                <span style={{ fontWeight: t.weightEmphasis }}>{label(month, { month: "long", year: "numeric" })}</span>
                <button type="button" aria-label="Next month" onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1)))} style={stepStyle}>›</button>
              </div>
              <div role="grid" style={{ display: "grid", gridTemplateColumns: "repeat(7, 32px)", gap: 2 }}>
                {WEEKDAYS.map((day, i) => (
                  <span key={i} style={{ ...microLabel, textAlign: "center" }}>{day}</span>
                ))}
                {gridOf(month).map((day, i) => {
                  if (day === null) return <span key={i} />;
                  const value = iso(day);
                  const outside = (min !== undefined && value < min) || (max !== undefined && value > max);
                  const edge = value === from || value === to;
                  const inside = from !== undefined && to !== undefined && value > from && value < to;
                  return (
                    <button
                      key={i}
                      type="button"
                      aria-pressed={edge}
                      disabled={outside}
                      onClick={() => pick(value)}
                      style={{
                        ...font,
                        border: 0,
                        borderRadius: t.radiusSmall,
                        color: edge ? t.accentText : t.text,
                        background: edge ? t.accent : inside ? `color-mix(in srgb, ${t.accent} 14%, ${t.surface})` : "transparent",
                        cursor: outside ? "not-allowed" : "pointer",
                        fontSize: "0.85em",
                        opacity: outside ? 0.35 : 1,
                        padding: "6px 0",
                        transition: transitionFor("background-color", "color"),
                      }}
                    >
                      {day.getUTCDate()}
                    </button>
                  );
                })}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </FieldShell>
  );
}

const stepStyle = { ...font, border: 0, background: "transparent", color: t.muted, cursor: "pointer", padding: "2px 6px" } as const;

/** spec §16 — ONE card shell, three laws.
 *
 *  Every consent/status card in the product is this shell with different
 *  CONTENTS: eyebrow · one-size icon well · title · the mandatory plain-words
 *  line · field rows or a list · actions · byline. Approval, connect,
 *  standing-access, automation and the resolved record are
 *  contents only, and every surface that shows one (thread, waiting strip,
 *  activities, mobile sheet, voice, embeds) renders the SAME shell.
 *
 *  1. Ancestors may set width/max-width on `.fl-cardshell` — never undress it.
 *  2. ONE icon well (28px), ONE primary button (`.fl-btn-primary`), ONE
 *     ceremony button (`.fl-btn-ceremony`).
 *  3. The plain-words line is mandatory: a card always says what it DOES.
 *
 *  Geometry lives in the `.fl-card-*` CSS. Some elements also
 *  carry their legacy `.fl-approval*` / `.fl-grant` class: three suites, the
 *  corpus harness and the thread's morph start-rect lookup select on those
 *  names. They are markers only — the `.fl-card-*` rules are declared later in
 *  the one stylesheet, so the shell's geometry always wins.
 *
 *  Deliberately NOT re-exported from `chrome/index.ts`: the shell is internal
 *  vocabulary (the export-surface test pins the public list), so surfaces
 *  import this module directly.
 */
import { useState, type HTMLAttributes, type ReactNode } from "react";
import { developmentMode } from "./dev-mode.js";
import type { CardFieldRow } from "./field-rows.js";

/** The eyebrow strings, once (six were hardcoded across the card files). The
    approval eyebrow itself stays with `toolPresentation` — it is the single
    humanization source and knows when an ask is an automation. */
export const CARD_EYEBROWS = {
  approval: "Needs your approval",
  automationApproval: "Automation · needs your approval",
  connect: "Connect",
  standingAccess: "Standing access",
  automationStatus: "Automation",
  resolved: "Approval",
  waiting: "Waiting on you",
} as const;

/* Law 3's fallback used to live here as `runsAsYouLine(title)` — "Vendo will
   run Send money as you.", the tool's label read back at the user. It is now
   `consentClassLine(name, risk)` in build-beat.tsx, which says what an approval
   DOES by class and never names the tool. */

const glyph = (path: ReactNode, size = 15): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {path}
  </svg>
);

/** The consent register's mark — every ask that is about permission. */
export const SHIELD_GLYPH = glyph(
  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />,
);
/** A tool with no brand of its own. */
export const TOOL_GLYPH = glyph(
  <>
    <path d="m21 2-9.6 9.6" /><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-1 1" />
    <path d="m15.5 7.5 3 3L22 7l-3-3" />
  </>,
  13,
);
export const LINK_GLYPH = glyph(<path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8" />);
export const BOLT_GLYPH = glyph(<path d="m13 2-9 12h8l-1 8 9-12h-8l1-8Z" />);
export const CLOCK_GLYPH = glyph(<><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>);
/** The settled mark (was inlined five times). */
export const TICK_GLYPH = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 12 4 4L19 6" />
  </svg>
);

const classes = (...names: (string | false | undefined)[]): string => names.filter(Boolean).join(" ");

export interface CardShellProps extends HTMLAttributes<HTMLElement> {
  /** The card's accessible name, e.g. `Approval for Send money`. */
  label: string;
  /** Destructive/irreversible register: the amber edge over the same card. */
  ceremony?: boolean;
  /** The card is a receipt, not an ask. */
  settled?: boolean;
  children: ReactNode;
}

export function CardShell({ label, className, ceremony, settled, children, ...rest }: CardShellProps) {
  return (
    <article
      className={classes("fl-cardshell", ceremony && "fl-cardshell--ceremony", settled && "fl-cardshell--settled", className)}
      aria-label={label}
      {...rest}
    >
      {children}
    </article>
  );
}

export function CardHead({ icon, eyebrow, title, aside }: {
  /** A `<ToolkitLogo>` or a glyph in the 28px well. */
  icon?: ReactNode;
  eyebrow: string;
  title: ReactNode;
  /** Trailing chip (risk, OAuth) — sits opposite the copy column. */
  aside?: ReactNode;
}) {
  return (
    <div className="fl-card-head">
      {icon}
      <div className="fl-card-heading">
        <div className="fl-card-eyebrow">{eyebrow}</div>
        <div className="fl-card-title">{title}</div>
      </div>
      {aside}
    </div>
  );
}

/** The mandatory plain-words line. */
export function CardLine({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={classes("fl-card-line", className)}>{children}</p>;
}

export function CardActions({ children }: { children: ReactNode }) {
  return <div className="fl-card-actions">{children}</div>;
}

/** Who is asking, or when it settled. Always last, always quiet. */
export function CardByline({ children }: { children: ReactNode }) {
  return <div className="fl-card-byline">{children}</div>;
}

export function CardList({ label, className, children }: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ul className={classes("fl-card-list", className)} {...(label === undefined ? {} : { "aria-label": label })}>
      {children}
    </ul>
  );
}

/**
 * The one body: the real inputs, as a person must read them.
 *
 * L37 — the `dd` used to carry `title={row.raw}` whenever display changed the
 * value, "keeping the raw input one hover away". A tooltip is an END-USER
 * surface: on a consent card that put raw JSON, `true`, `4750` and the
 * developer's literals one hover from a bank customer — and the law's sweep
 * could not see any of it, because `readable()` excluded `title` by
 * construction. RULING: the honesty contract is satisfied by the
 * ROWS (every real input is displayed, always); the raw literal is a developer's
 * aid and rides the tooltip in dev mode only. `CardFieldRow.raw` still exists —
 * it is what dev mode shows, and what tests assert on.
 */
export function CardFields({ rows, label = "Real tool inputs" }: {
  rows: CardFieldRow[];
  label?: string;
}) {
  if (rows.length === 0) return null;
  return (
    // Legacy `.fl-approval-field*` markers: the money and consent suites select
    // on them (see the module header).
    <dl className="fl-card-fields fl-approval-fields" aria-label={label}>
      {rows.map((row, index) => (
        <div className="fl-card-field fl-approval-field" key={`${row.label}-${index}`}>
          <dt>{row.label}</dt>
          <dd
            {...(row.numeric ? { "data-numeric": "" } : {})}
            {...(developmentMode() && row.raw !== row.value ? { title: row.raw } : {})}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A remote toolkit mark that can always fail: Composio's logo CDN was called
    from four places and only ONE carried an `onError`, so a network failure or
    an unknown slug left an empty well. Keyed to `src` so a prop change retries. */
export function ToolkitLogo({ src, fallback = TOOL_GLYPH, className = "fl-card-ic" }: {
  src?: string;
  fallback?: ReactNode;
  className?: string;
}) {
  const [failed, setFailed] = useState<string>();
  return (
    <span className={className} aria-hidden="true">
      {src !== undefined && failed !== src ? (
        // eslint-disable-next-line @next/next/no-img-element -- chrome surface, plain img by design
        <img src={src} alt="" onError={() => setFailed(src)} />
      ) : fallback}
    </span>
  );
}

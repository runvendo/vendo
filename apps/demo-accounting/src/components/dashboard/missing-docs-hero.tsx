"use client"

/**
 * The dashboard's hero number — clients with documents still outstanding —
 * remixable by Vendo (06-apps §8).
 *
 * Deliberately self-contained (React only, inline styles) so `vendo sync`
 * static capture reproduces it faithfully inside the sandboxed jail, whose
 * module space is React plus captured sub-sources and whose CSS is the
 * captured app-root stylesheet, not the compiled Tailwind bundle. The values
 * mirror the Cadence brand tokens in `src/app/globals.css`.
 */

const EVERGREEN_800 = "#1c4339"
const EVERGREEN_900 = "#16362e"
const EVERGREEN_950 = "#0b211c"
const EVERGREEN_100 = "#d8ebe2"
const STATUS_MISSING = "#b45309"
const STATUS_MISSING_BG = "#fdf0df"
const FONT = 'var(--font-hanken, system-ui), ui-sans-serif, system-ui, sans-serif'

export interface MissingDocsHeroProps {
  /** Clients with at least one outstanding (missing/rejected) document. */
  missingCount: number
  /** All active clients. */
  clientCount: number
  badgeLabel?: string
}

export function MissingDocsHero({
  missingCount,
  clientCount,
  badgeLabel = "Action needed",
}: MissingDocsHeroProps) {
  return (
    <article
      style={{
        borderRadius: 12,
        border: `1px solid ${EVERGREEN_900}`,
        background: `linear-gradient(to bottom right, ${EVERGREEN_800}, ${EVERGREEN_950})`,
        boxShadow: "0 1px 2px rgba(34,30,25,0.05), 0 1px 3px rgba(34,30,25,0.03)",
        padding: 20,
        fontFamily: FONT,
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 13,
          fontWeight: 500,
          whiteSpace: "nowrap",
          color: "rgba(216,235,226,0.8)",
        }}
      >
        Clients missing documents
      </p>
      <div
        style={{
          marginTop: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span
          style={{
            fontSize: 40,
            lineHeight: 1,
            fontWeight: 600,
            letterSpacing: "-0.025em",
            color: "#ffffff",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {missingCount}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            borderRadius: 9999,
            padding: "2px 8px",
            fontSize: 11,
            fontWeight: 500,
            whiteSpace: "nowrap",
            background: STATUS_MISSING_BG,
            color: STATUS_MISSING,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: 9999,
              background: "currentcolor",
            }}
          />
          {badgeLabel}
        </span>
      </div>
      <p
        style={{
          margin: "10px 0 0",
          fontSize: 12,
          color: `${EVERGREEN_100}99`,
        }}
      >
        of {clientCount} active clients need chasing
      </p>
    </article>
  )
}

// The jail's module loader renders a fork's DEFAULT export (08-ui §5), so a
// remixable component must carry one; the named export stays for host imports.
export default MissingDocsHero

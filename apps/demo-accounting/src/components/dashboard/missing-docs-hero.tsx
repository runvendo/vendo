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

const INK = "#111111"
const INK_SOFT = "#46443f"
const INK_FAINT = "#908c85"
const LINE = "#ecebe8"
const LEDGER_GREEN = "#1e7f53"
const STATUS_MISSING = "#a16207"
const STATUS_MISSING_BG = "#faf3e3"
const FONT = 'var(--font-inter, system-ui), ui-sans-serif, system-ui, sans-serif'

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
        border: `1px solid ${LINE}`,
        background: "#ffffff",
        boxShadow: `inset 3px 0 0 ${LEDGER_GREEN}, 0 1px 2px rgba(17,17,17,0.04)`,
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
          color: INK_SOFT,
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
            color: INK,
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
          color: INK_FAINT,
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

import React from 'react';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {SPRING_CFG} from '../template/theme';
import {CAD, CAD_FONT, RADIUS, SHADOW} from './tokens';

/**
 * Cadence's real settings page, replicated markup-for-markup.
 *
 * Source of truth: `examples/demo-accounting/src/app/settings/page.tsx` plus the
 * primitives it composes — `src/components/ui/card.tsx`,
 * `src/components/ui/page-header.tsx` — and the `@theme` tokens in
 * `src/app/globals.css`. Every class in the host is quoted in the comment
 * beside the style that resolves it, so the two are diffable line by line.
 *
 * Why replicated and not imported: Cadence is Tailwind v4 CSS-first with no
 * config file (`postcss.config.mjs` is the whole build), so those components are
 * bags of utility classes that only resolve through Cadence's own PostCSS
 * pipeline, which Remotion does not run. The contract's task 3 authorises
 * exactly this branch for host chrome ("else compose from … the Cadence design
 * tokens (real tokens from its codebase, not eyeballed)"). The real class names
 * are carried in `className` alongside the resolved styles, so a reader can grep
 * the host for any of them.
 *
 * Everything here is authored at Cadence's REAL pixel sizes — 13px row labels,
 * 12px hints, a 20x36 toggle. The film reads them at a distance because the
 * scene's camera is zoomed in on the card, which is what a screen recording of
 * a settings page looks like. No value is inflated for the camera.
 */

/** Tailwind's spacing scale, so `px-5` / `py-3.5` stay legible as themselves. */
const SPACE = (n: number): number => n * 4;

/** `divide-line/60` and `border-line/70` — the host's line colour at alpha. */
const LINE_60 = 'rgba(236, 235, 232, 0.6)';
const LINE_70 = 'rgba(236, 235, 232, 0.7)';

export const CADENCE_COL_WIDTH = 768; // max-w-3xl
/** The toggle's centre, measured in from the column's right edge: the card's
 *  1px border, the row's `px-5` (20) and half a `w-9` toggle (18). The
 *  detonation is pinned to this point. */
export const CADENCE_TOGGLE_INSET = 1 + SPACE(5) + 18;

/** page-header.tsx — `flex items-end justify-between gap-4`, `text-[22px]
 *  font-semibold tracking-tight`, description `mt-1 text-[13.5px] text-ink-soft`. */
const PageHeader: React.FC<{title: string; description: string}> = ({
  title,
  description,
}) => (
  <div className="flex items-end justify-between gap-4">
    <div>
      <h1
        style={{
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: '-0.0125em',
          color: CAD.ink,
          margin: 0,
        }}
      >
        {title}
      </h1>
      <p
        style={{
          marginTop: SPACE(1),
          marginBottom: 0,
          fontSize: 13.5,
          color: CAD.inkSoft,
        }}
      >
        {description}
      </p>
    </div>
  </div>
);

/** card.tsx — `rounded-xl border border-line bg-card shadow-card`. */
const Card: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div
    className="rounded-xl border border-line bg-card shadow-card overflow-hidden"
    style={{
      borderRadius: RADIUS.medium,
      border: `1px solid ${CAD.line}`,
      backgroundColor: CAD.card,
      boxShadow: SHADOW.card,
      overflow: 'hidden',
    }}
  >
    {children}
  </div>
);

/** card.tsx `CardHeader` — `flex items-center justify-between px-5 pt-4 pb-3`,
 *  title `text-[13px] font-semibold tracking-tight`. */
const CardHeader: React.FC<{title: string}> = ({title}) => (
  <div
    className="flex items-center justify-between px-5 pt-4 pb-3"
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: `${SPACE(4)}px ${SPACE(5)}px ${SPACE(3)}px`,
    }}
  >
    <h2
      style={{
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: '-0.0125em',
        color: CAD.ink,
        margin: 0,
      }}
    >
      {title}
    </h2>
  </div>
);

/** settings/page.tsx `Row` — `flex items-center justify-between gap-8 px-5
 *  py-3.5`, label `text-[13px] font-medium`, hint `mt-0.5 text-[12px]
 *  text-ink-faint`. */
const Row: React.FC<{
  label: string;
  hint?: string;
  lead?: React.ReactNode;
  dim?: boolean;
  children?: React.ReactNode;
}> = ({label, hint, lead, dim = false, children}) => (
  <div
    className="flex items-center justify-between gap-8 px-5 py-3.5"
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: SPACE(8),
      padding: `${SPACE(3.5)}px ${SPACE(5)}px`,
      opacity: dim ? 0.45 : 1,
    }}
  >
    <div
      className="min-w-0"
      style={{
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: SPACE(2.5),
      }}
    >
      {lead}
      <div>
        <p style={{fontSize: 13, fontWeight: 500, color: CAD.ink, margin: 0}}>
          {label}
        </p>
        {hint === undefined ? null : (
          <p
            style={{
              marginTop: SPACE(0.5),
              marginBottom: 0,
              fontSize: 12,
              color: CAD.inkFaint,
            }}
          >
            {hint}
          </p>
        )}
      </div>
    </div>
    <div
      className="flex shrink-0 items-center gap-2"
      style={{
        display: 'flex',
        flexShrink: 0,
        alignItems: 'center',
        gap: SPACE(2),
      }}
    >
      {children}
    </div>
  </div>
);

/**
 * settings/page.tsx `Toggle` — `inline-flex h-5 w-9 items-center rounded-full
 * px-0.5 opacity-70`, `bg-ink` when on / `bg-line-strong` when off, knob
 * `h-4 w-4 rounded-full bg-white shadow-card`.
 *
 * The host's toggles are disabled and static (firm settings are owner-managed).
 * The film's one addition is the flip itself: the knob and the track colour ride
 * a Remotion spring at `flipAt`. Ink, never violet — the host's own switch
 * colour. The `opacity-70` disabled dimming is dropped for the same reason: on
 * camera this switch is being used, not shown as read-only.
 */
export const CadenceToggle: React.FC<{flipAt: number}> = ({flipAt}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s =
    frame < flipAt
      ? 0
      : spring({frame: frame - flipAt, fps, config: SPRING_CFG});
  const pad = SPACE(0.5); // px-0.5
  const knob = SPACE(4); // h-4 w-4
  const track = {w: SPACE(9), h: SPACE(5)}; // w-9 h-5
  const on = interpolate(s, [0, 0.5], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <span
      role="switch"
      aria-checked={s > 0.5}
      className="inline-flex h-5 w-9 items-center rounded-full px-0.5"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        width: track.w,
        height: track.h,
        borderRadius: 9999,
        backgroundColor: on > 0.5 ? CAD.ink : CAD.lineStrong,
        position: 'relative',
      }}
    >
      <span
        className="h-4 w-4 rounded-full bg-white shadow-card"
        style={{
          position: 'absolute',
          left: pad + s * (track.w - knob - pad * 2),
          width: knob,
          height: knob,
          borderRadius: 9999,
          backgroundColor: '#ffffff',
          boxShadow: SHADOW.card,
        }}
      />
    </span>
  );
};

/** settings/page.tsx — `divide-y divide-line/60 border-t border-line/70`. */
const RowList: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div
    className="divide-y divide-line/60 border-t border-line/70"
    style={{borderTop: `1px solid ${LINE_70}`}}
  >
    {React.Children.toArray(children).map((child, index) => (
      <div
        key={index}
        style={
          index === 0 ? undefined : {borderTop: `1px solid ${LINE_60}`}
        }
      >
        {child}
      </div>
    ))}
  </div>
);

export interface CadenceSettingsCardProps {
  /** The card's `CardHeader` title. */
  sectionLabel: string;
  /** The agent capability being switched on — the episode's subject. */
  feature: {title: string; subtitle: string};
  /** The row below, which sells that this is a real settings page. Omitted by
   *  the pulled-back view, which crops before it. */
  nextFeature?: {title: string; subtitle: string};
  /** Scene-local frame at which the toggle flips on. */
  flipAt: number;
  /** The vendo blob mark, placed inside the real row's leading cell. */
  mark: React.ReactNode;
}

/** The page as Cadence lays it out: `max-w-3xl space-y-6`, PageHeader + Cards. */
export const CadenceSettingsCard: React.FC<CadenceSettingsCardProps> = ({
  sectionLabel,
  feature,
  nextFeature,
  flipAt,
  mark,
}) => (
  <div
    className="max-w-3xl space-y-6"
    style={{
      width: CADENCE_COL_WIDTH,
      fontFamily: CAD_FONT,
      color: CAD.ink,
      display: 'flex',
      flexDirection: 'column',
      gap: SPACE(6),
    }}
  >
    <PageHeader
      title="Settings"
      description="Firm workspace settings for Hartwell & Associates"
    />
    <Card>
      <CardHeader title={sectionLabel} />
      <RowList>
        <Row
          label={feature.title}
          hint={feature.subtitle}
          lead={
            /* badge.tsx neutral variant — `border border-line bg-surface`. */
            <span
              className="border border-line bg-surface"
              style={{
                display: 'grid',
                placeItems: 'center',
                width: SPACE(6),
                height: SPACE(6),
                borderRadius: RADIUS.small,
                border: `1px solid ${CAD.line}`,
                backgroundColor: CAD.surface,
                flexShrink: 0,
              }}
            >
              {mark}
            </span>
          }
        >
          <span style={{fontSize: 12, color: CAD.inkSoft}}>Enable</span>
          <CadenceToggle flipAt={flipAt} />
        </Row>
        {nextFeature === undefined ? (
          <></>
        ) : (
          <Row label={nextFeature.title} hint={nextFeature.subtitle} dim>
            <span style={{fontSize: 12, color: CAD.inkFaint}}>Enable</span>
            <CadenceToggle flipAt={Number.POSITIVE_INFINITY} />
          </Row>
        )}
      </RowList>
    </Card>
    {/* The host's own next card, verbatim from settings/page.tsx — the page
        continues below the fold exactly as a user would see it. */}
    <Card>
      <CardHeader title="Notifications" />
      <RowList>
        <Row
          label="Client upload alerts"
          hint="Notify the assignee the moment a document lands"
        >
          <CadenceToggle flipAt={-1} />
        </Row>
        <Row
          label="Deadline reminders"
          hint="Escalate when a filing is 21 days out with documents missing"
        >
          <CadenceToggle flipAt={-1} />
        </Row>
        <Row
          label="Daily digest"
          hint="Morning summary of outstanding documents across the firm"
        >
          <CadenceToggle flipAt={Number.POSITIVE_INFINITY} />
        </Row>
      </RowList>
    </Card>
  </div>
);

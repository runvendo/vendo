import React from 'react';
import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {C} from '../template/theme';
import {Cursor} from '../template/Cursor';
import {VendoStage} from '../template/VendoStage';
import {SLOT} from '../template/WidgetFlight';
import {Turn, viewTurn, weeklyUsagePayload} from './agent-surface';
import {MissingDocsHero} from '../../../../examples/demo-accounting/src/components/dashboard/missing-docs-hero';
import {
  CAD,
  CAD_BRAND_FONT,
  CAD_FIRM,
  CAD_FONT,
  CAD_NAV,
  CAD_SEASON,
  EVERGREEN,
  RADIUS,
  SHADOW,
  STATUS,
  cad,
} from '../cadence/tokens';

// Frames 244-310 (66 local). The host console — Cadence — is revealed by a
// camera pullback while the generated view flies in from the chat. The slot
// stays empty until the flight overlay lands at local 22, then the REAL app
// card takes over with a squash release. A white radial wash from the card's
// violet dot wipes to the claim card.
//
// The dashboard is Cadence's own product surface: the real MissingDocsHero
// component imported from examples/demo-accounting, and every colour, radius,
// shadow and nav label taken from ../cadence/tokens (which quotes the host's
// globals.css verbatim). Nothing here is an invented UI language.

const LAND_AT = 22;
const SLOT_CENTER = {x: SLOT.x + SLOT.w / 2, y: SLOT.y + SLOT.h / 2};
/** The app card's violet bar dot — origin of the wash out. */
const WASH = {x: SLOT.x + cad(18), y: SLOT.y + cad(14)};

const SIDEBAR_W = cad(150);
const TOPBAR_H = cad(56);

/** The host's page grid: a two-column content column beside the nav rail. */
const CONTENT_X = SIDEBAR_W + 45;
const COL_W = 780;
const GAP = 26;
const ROW = {
  header: TOPBAR_H + 24,
  stats: TOPBAR_H + 114,
  deadlines: TOPBAR_H + 330,
  mid: TOPBAR_H + 636,
  tail: TOPBAR_H + 1092,
};
/** Scrolled so the pullback lands on the slot at SLOT.y. */
const SCROLL_Y = SLOT.y - ROW.mid;

/* ---------------------------------------------------------------- */
/* Cadence chrome, composed from the host's real tokens              */
/* ---------------------------------------------------------------- */

const CadenceCard: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  action?: string;
  children?: React.ReactNode;
}> = ({x, y, w, h, title, action, children}) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: w,
      height: h,
      borderRadius: RADIUS.medium,
      border: `1px solid ${CAD.line}`,
      backgroundColor: CAD.card,
      boxShadow: SHADOW.card,
      overflow: 'hidden',
    }}
  >
    {title === undefined ? null : (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${cad(16)}px ${cad(20)}px ${cad(12)}px`,
        }}
      >
        <div
          style={{
            fontSize: cad(13),
            fontWeight: 600,
            letterSpacing: '-0.01em',
            color: CAD.ink,
          }}
        >
          {title}
        </div>
        {action === undefined ? null : (
          <div style={{fontSize: cad(12), color: CAD.inkFaint}}>{action}</div>
        )}
      </div>
    )}
    <div style={{padding: `0 ${cad(20)}px`}}>{children}</div>
  </div>
);

const StatTile: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  value: string;
  suffix?: string;
  sub: string;
  chipBg: string;
  chipFg: string;
}> = ({x, y, w, h, label, value, suffix, sub, chipBg, chipFg}) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: w,
      height: h,
      borderRadius: RADIUS.medium,
      border: `1px solid ${CAD.line}`,
      backgroundColor: CAD.card,
      boxShadow: SHADOW.card,
      padding: cad(20),
    }}
  >
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
      }}
    >
      <div style={{fontSize: cad(13), fontWeight: 500, color: CAD.inkSoft}}>
        {label}
      </div>
      <div
        style={{
          width: cad(32),
          height: cad(32),
          borderRadius: cad(8),
          backgroundColor: chipBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: cad(13),
            height: cad(13),
            borderRadius: 3,
            border: `2px solid ${chipFg}`,
          }}
        />
      </div>
    </div>
    <div
      style={{
        marginTop: cad(12),
        fontSize: cad(32),
        fontWeight: 600,
        letterSpacing: '-0.02em',
        lineHeight: 1,
        color: CAD.ink,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {value}
      {suffix === undefined ? null : (
        <span
          style={{
            marginLeft: cad(6),
            fontSize: cad(15),
            fontWeight: 500,
            letterSpacing: 'normal',
            color: CAD.inkSoft,
          }}
        >
          {suffix}
        </span>
      )}
    </div>
    <div style={{marginTop: cad(10), fontSize: cad(12), color: CAD.inkFaint}}>
      {sub}
    </div>
  </div>
);

const Sidebar: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      top: 0,
      width: SIDEBAR_W,
      height: 1080,
      backgroundColor: CAD.surface,
      borderRight: `1px solid ${CAD.line}`,
      display: 'flex',
      flexDirection: 'column',
    }}
  >
    <div
      style={{
        height: TOPBAR_H,
        display: 'flex',
        alignItems: 'center',
        padding: `0 ${cad(20)}px`,
      }}
    >
      <span
        style={{
          fontFamily: CAD_BRAND_FONT,
          fontWeight: 700,
          letterSpacing: '-0.035em',
          fontSize: cad(20),
          color: CAD.ink,
        }}
      >
        cadence
        <span style={{color: EVERGREEN[500]}}>.</span>
      </span>
    </div>
    <div style={{padding: `${cad(8)}px ${cad(12)}px`, flex: 1}}>
      {CAD_NAV.map((group, gi) => (
        <div key={group.group ?? 'root'} style={{marginTop: gi === 0 ? 0 : cad(18)}}>
          {group.group === undefined ? null : (
            <div
              style={{
                padding: `0 ${cad(10)}px ${cad(6)}px`,
                fontSize: cad(10.5),
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: CAD.inkFaint,
              }}
            >
              {group.group}
            </div>
          )}
          {group.items.map((item) => {
            const active = item === 'Dashboard';
            return (
              <div
                key={item}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: cad(10),
                  padding: `${cad(6)}px ${cad(10)}px`,
                  borderRadius: RADIUS.small,
                  marginBottom: cad(2),
                  backgroundColor: active ? CAD.line : 'transparent',
                  color: active ? CAD.ink : CAD.inkSoft,
                  fontSize: cad(13),
                  fontWeight: 500,
                }}
              >
                <div
                  style={{
                    width: cad(15),
                    height: cad(15),
                    borderRadius: 4,
                    border: `1.6px solid ${active ? CAD.ink : CAD.inkFaint}`,
                  }}
                />
                {item}
              </div>
            );
          })}
        </div>
      ))}
    </div>
    <div
      style={{
        borderTop: `1px solid ${CAD.line}`,
        padding: `${cad(16)}px ${cad(20)}px`,
      }}
    >
      <div style={{fontSize: cad(11), fontWeight: 500, color: CAD.inkSoft}}>
        {CAD_FIRM}
      </div>
      <div style={{marginTop: cad(2), fontSize: cad(10.5), color: CAD.inkFaint}}>
        {CAD_SEASON}
      </div>
    </div>
  </div>
);

const Topbar: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      left: SIDEBAR_W,
      top: 0,
      right: 0,
      height: TOPBAR_H,
      display: 'flex',
      alignItems: 'center',
      gap: cad(16),
      padding: `0 ${cad(24)}px`,
      backgroundColor: CAD.card,
      borderBottom: `1px solid ${CAD.line}`,
    }}
  >
    <div
      style={{
        width: cad(320),
        height: cad(32),
        borderRadius: cad(8),
        border: `1px solid ${CAD.line}`,
        backgroundColor: CAD.surface,
        display: 'flex',
        alignItems: 'center',
        padding: `0 ${cad(10)}px`,
        fontSize: cad(12.5),
        color: CAD.inkFaint,
      }}
    >
      Search clients, documents…
    </div>
    <div style={{flex: 1}} />
    <div style={{fontSize: cad(13), fontWeight: 500, color: CAD.inkSoft}}>
      {CAD_FIRM}
    </div>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: cad(8),
        borderRadius: 999,
        border: `1px solid ${CAD.line}`,
        padding: `${cad(4)}px ${cad(12)}px ${cad(4)}px ${cad(4)}px`,
      }}
    >
      <div
        style={{
          width: cad(24),
          height: cad(24),
          borderRadius: '50%',
          backgroundColor: CAD.ink,
          color: '#fff',
          fontSize: cad(10),
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        MA
      </div>
      <span style={{fontSize: cad(12.5), color: CAD.inkSoft}}>Maya Alvarez</span>
    </div>
  </div>
);

/** Real client engagements from the host's seed (src/server/seed.ts). */
const DEADLINES: Array<[string, string, string]> = [
  ['Blue Bottle Coffee', 'S-Corp', '2d'],
  ['Linear', 'Sole Prop', '3d'],
  ['Sweetgreen', 'Partnership', 'in 21 days'],
  ['Equinox', 'S-Corp', 'in 25 days'],
];

const ACTIVITY: string[] = [
  'Marisol Rivera uploaded Payroll summary',
  'Prior-year return verified for Compass',
  'Dana Kowalski uploaded Receipts',
  'Bank statements rejected for Jiffy Lube',
];

export const SceneProofC: React.FC = () => {
  const frame = useCurrentFrame();

  // Camera: pull WAY back (1.5 -> 1.0) around the slot, then the continuous
  // push-in law takes over.
  const pullback = interpolate(frame, [0, 18], [1.5, 1], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const push = interpolate(frame, [18, 66], [1, 1.03], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const cam = pullback * push;

  // The landed card releases its squash (scaleY 0.96 -> 1).
  const unsquash = interpolate(frame, [LAND_AT, LAND_AT + 3], [0.96, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // White wash out: expanding white flood from the card's violet bar dot.
  const washP = interpolate(frame, [58, 66], [0, 1], {
    easing: Easing.in(Easing.quad),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const washR = washP * 2300;

  return (
    <AbsoluteFill style={{backgroundColor: CAD.surface, fontFamily: CAD_FONT}}>
      <AbsoluteFill
        style={{
          transform: `scale(${cam})`,
          transformOrigin: `${SLOT_CENTER.x}px ${SLOT_CENTER.y}px`,
        }}
      >
        {/* Scrolled page content */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            transform: `translateY(${SCROLL_Y}px)`,
          }}
        >
          <div style={{position: 'absolute', left: CONTENT_X, top: ROW.header}}>
            <div
              style={{
                fontSize: cad(22),
                fontWeight: 600,
                letterSpacing: '-0.02em',
                color: CAD.ink,
              }}
            >
              Dashboard
            </div>
            <div
              style={{marginTop: cad(6), fontSize: cad(13.5), color: CAD.inkSoft}}
            >
              Tax season at a glance for {CAD_FIRM}
            </div>
          </div>

          {/* Stat row — the first cell is Cadence's REAL hero component */}
          <div
            style={{
              position: 'absolute',
              left: CONTENT_X,
              top: ROW.stats,
              width: COL_W,
              fontSize: cad(13),
            }}
          >
            <MissingDocsHero missingCount={8} clientCount={12} />
          </div>
          <StatTile
            x={CONTENT_X + COL_W + GAP}
            y={ROW.stats}
            w={COL_W}
            h={cad(118)}
            label="Documents outstanding"
            value="21"
            sub="still to collect this season"
            chipBg={CAD.line}
            chipFg={CAD.inkSoft}
          />

          <CadenceCard
            x={CONTENT_X}
            y={ROW.deadlines}
            w={COL_W * 2 + GAP}
            h={cad(172)}
            title="Upcoming deadlines"
            action="View calendar"
          >
            {DEADLINES.map(([name, entity, due], i) => (
              <div
                key={name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: cad(12),
                  padding: `${cad(9)}px 0`,
                  borderBottom:
                    i < DEADLINES.length - 1 ? `1px solid ${CAD.line}` : 'none',
                }}
              >
                <div
                  style={{
                    width: cad(30),
                    height: cad(30),
                    borderRadius: cad(9),
                    backgroundColor: CAD.surface,
                    border: `1px solid ${CAD.line}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: cad(11),
                    fontWeight: 600,
                    color: CAD.inkSoft,
                  }}
                >
                  {name.slice(0, 2).toUpperCase()}
                </div>
                <div style={{flex: 1}}>
                  <div
                    style={{fontSize: cad(13), fontWeight: 500, color: CAD.ink}}
                  >
                    {name}
                    <span
                      style={{
                        marginLeft: cad(8),
                        padding: `${cad(2)}px ${cad(7)}px`,
                        borderRadius: 999,
                        border: `1px solid ${CAD.line}`,
                        fontSize: cad(10.5),
                        fontWeight: 500,
                        color: CAD.inkSoft,
                      }}
                    >
                      {entity}
                    </span>
                  </div>
                </div>
                <div
                  style={{
                    minWidth: cad(88),
                    textAlign: 'center',
                    borderRadius: 999,
                    padding: `${cad(4)}px ${cad(10)}px`,
                    fontSize: cad(11),
                    fontWeight: 500,
                    fontVariantNumeric: 'tabular-nums',
                    backgroundColor: i < 2 ? STATUS.missingBg : CAD.line,
                    color: i < 2 ? STATUS.missing : CAD.inkSoft,
                  }}
                >
                  {due}
                </div>
              </div>
            ))}
          </CadenceCard>

          <CadenceCard
            x={CONTENT_X}
            y={ROW.mid}
            w={COL_W}
            h={SLOT.h}
            title="Recent activity"
          >
            {ACTIVITY.map((line, i) => (
              <div
                key={line}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: cad(10),
                  padding: `${cad(9)}px 0`,
                }}
              >
                <div
                  style={{
                    width: cad(26),
                    height: cad(26),
                    borderRadius: '50%',
                    backgroundColor:
                      i === 1 ? STATUS.verifiedBg : STATUS.reviewBg,
                    flexShrink: 0,
                  }}
                />
                <div>
                  <div
                    style={{fontSize: cad(12.5), lineHeight: 1.35, color: CAD.ink}}
                  >
                    {line}
                  </div>
                  <div
                    style={{
                      marginTop: cad(3),
                      fontSize: cad(11),
                      color: CAD.inkFaint,
                    }}
                  >
                    {['just now', '5m ago', '2h ago', '3d ago'][i]}
                  </div>
                </div>
              </div>
            ))}
          </CadenceCard>

          {/* Document collection — Cadence's signature progress stat */}
          <CadenceCard
            x={CONTENT_X}
            y={ROW.tail}
            w={COL_W}
            h={cad(150)}
            title="Document collection"
          >
            <div style={{marginTop: cad(6), fontSize: cad(13), color: CAD.inkSoft}}>
              38 of 59 collected, 64%
            </div>
            <div
              style={{
                marginTop: cad(12),
                height: cad(6),
                borderRadius: 999,
                backgroundColor: CAD.line,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: '64%',
                  height: '100%',
                  backgroundColor: EVERGREEN[500],
                }}
              />
            </div>
          </CadenceCard>

          <StatTile
            x={CONTENT_X + COL_W + GAP}
            y={ROW.tail}
            w={COL_W}
            h={cad(150)}
            label="Next filing deadline"
            value="2"
            suffix="days"
            sub="Blue Bottle Coffee · Jul 17"
            chipBg={STATUS.missingBg}
            chipFg={STATUS.missing}
          />
        </div>

        {/* Fixed host chrome, above the scrolling page */}
        <Sidebar />
        <Topbar />

        {/* The slot stays empty until the flight lands, then the REAL app card
            takes over and releases the landing squash. */}
        {frame >= LAND_AT ? (
          <div
            style={{
              position: 'absolute',
              left: SLOT.x,
              top: SLOT.y,
              width: SLOT.w,
              transform: `scaleY(${unsquash})`,
              transformOrigin: 'center bottom',
            }}
          >
            <VendoStage>
              <Turn
                message={viewTurn(
                  'kept-view',
                  'weekly-usage',
                  weeklyUsagePayload(
                    {stats: true, chart: true, schedule: true},
                    false,
                  ),
                )}
              />
            </VendoStage>
          </div>
        ) : null}

        <Cursor
          path={[
            {frame: 0, x: 1740, y: 620},
            {frame: 30, x: 1720, y: 700, bulge: 26},
            {frame: 56, x: 1738, y: 760, bulge: -24},
            {frame: 66, x: 1732, y: 770},
          ]}
        />
      </AbsoluteFill>

      {/* White wash: the inverse of the detonation, quieter */}
      {washR > 1 ? (
        <div
          style={{
            position: 'absolute',
            left: WASH.x - washR,
            top: WASH.y - washR,
            width: washR * 2,
            height: washR * 2,
            borderRadius: '50%',
            backgroundColor: C.white,
            zIndex: 300,
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};

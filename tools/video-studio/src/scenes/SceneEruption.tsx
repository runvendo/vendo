import React, {useMemo} from 'react';
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {C, pushIn, snap, snapStyle} from '../template/theme';
import {Cursor} from '../template/Cursor';
import {DocIcon, VendoMark} from '../template/ui';
import {
  CADENCE_COL_WIDTH,
  CadenceSettingsCard,
} from '../cadence/settings';

// Frames 18-75 (57 local). The console pulled back; file chips get
// inhaled into a glowing violet orb; kinetic type punches in bottom-left.
// The orb hands off to the OrbWhip overlay at local frame 50.

const ORB = {x: 1290, y: 430};
export const ORB_HIDE_AT = 50;

// Exclusion zone around the settings card — chips must not cross its text.
const EXCL = {x0: 80, y0: 80, x1: 720, y1: 480};

export const DEFAULT_ERUPTION_FILES = [
  'README.md',
  'api-schema.json',
  'changelog.md',
  'guides/auth.mdx',
  'pricing.mdx',
  'openapi.yaml',
  'users.sql',
  'billing.ts',
  'faq.mdx',
  'roles.json',
  'webhooks.md',
  'audit-log.csv',
  'sso-setup.mdx',
  'quickstart.mdx',
  'limits.md',
  'teams.sql',
  'events.json',
  'digest-email.tsx',
  'permissions.md',
  'usage.parquet',
  'api-keys.md',
  'release-notes.md',
  'schema.prisma',
  'tickets.csv',
  'onboarding.mdx',
  'invoices.sql',
  'errors.md',
  'plans.json',
  'security.mdx',
  'orders.csv',
  'glossary.md',
  'refunds.ts',
  'migrations.sql',
  'branding.mdx',
];

const rand = (i: number, salt: number) => {
  const v = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

type ChipSpec = {
  name: string;
  sx: number;
  sy: number;
  start: number;
  dur: number;
  bulge: number;
};

const bezierAt = (sx: number, sy: number, bulge: number, e: number) => {
  const dx = ORB.x - sx;
  const dy = ORB.y - sy;
  const len = Math.hypot(dx, dy) || 1;
  const cx = (sx + ORB.x) / 2 + (-dy / len) * bulge;
  const cy = (sy + ORB.y) / 2 + (dx / len) * bulge;
  const u = 1 - e;
  return {
    x: u * u * sx + 2 * u * e * cx + e * e * ORB.x,
    y: u * u * sy + 2 * u * e * cy + e * e * ORB.y,
  };
};

const pathClear = (sx: number, sy: number, bulge: number) => {
  for (let t = 0.02; t < 0.92; t += 0.045) {
    const {x, y} = bezierAt(sx, sy, bulge, t);
    if (x > EXCL.x0 && x < EXCL.x1 && y > EXCL.y0 && y < EXCL.y1) return false;
  }
  return true;
};

const buildChips = (files: string[]): ChipSpec[] => files.map((name, i) => {
  const side = i % 4;
  const along = rand(i, 1);
  let sx = 0;
  let sy = 0;
  if (side === 0) {
    sx = -220;
    sy = 60 + along * 960;
  } else if (side === 1) {
    sx = 100 + along * 1720;
    sy = -80;
  } else if (side === 2) {
    sx = 2060;
    sy = 60 + along * 960;
  } else {
    sx = 100 + along * 1720;
    sy = 1150;
  }
  // Tighter arcs — the stream visibly bends INTO the orb.
  let bulge = (rand(i, 4) - 0.5) * 250;
  // Reroute any chip whose path crosses the settings card: try growing
  // bulges on either side, then relocate the spawn point away from the card.
  if (!pathClear(sx, sy, bulge)) {
    const candidates = [
      -bulge,
      bulge + 260,
      -(bulge + 260),
      bulge + 460,
      -(bulge + 460),
      560,
      -560,
    ];
    const found = candidates.find((b) => pathClear(sx, sy, b));
    if (found !== undefined) {
      bulge = found;
    } else {
      if (side === 0) sy = 580 + along * 440;
      else if (side === 1) sx = 800 + along * 1020;
      const found2 = [bulge, ...candidates].find((b) => pathClear(sx, sy, b));
      if (found2 !== undefined) bulge = found2;
    }
  }
  return {
    name,
    sx,
    sy,
    // Dense storm timed to the reveal: the detonation hands off around
    // local frame 20, so launches at 10-24 fill the screen the moment
    // the violet clears.
    start: 10 + Math.floor(rand(i, 2) * 15),
    dur: 18 + Math.floor(rand(i, 3) * 9),
    bulge,
  };
});

const chipAt = (spec: ChipSpec, frame: number) => {
  const t = interpolate(frame, [spec.start, spec.start + spec.dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // Accelerating toward the orb, but on-screen early: velocity grows
  // from 0.4 to 2.2 over the flight instead of starting near zero.
  const e = 0.4 * t + 0.6 * t * t * t;
  const {x, y} = bezierAt(spec.sx, spec.sy, spec.bulge, e);
  const scale = interpolate(e, [0, 0.55, 1], [1, 0.95, 0]);
  return {t, x, y, scale};
};

const ChipBody: React.FC<{name: string}> = ({name}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '11px 20px',
      borderRadius: 999,
      backgroundColor: C.white,
      border: `1px solid ${C.border}`,
      boxShadow: '0 2px 12px rgba(108,59,255,0.10)',
      fontSize: 21,
      fontWeight: 500,
      color: C.body,
      whiteSpace: 'nowrap',
    }}
  >
    <DocIcon size={19} color={C.violet} />
    {name}
  </div>
);

const TRAIL = [
  {back: 1, opacity: 0.16},
  {back: 2, opacity: 0.07},
  {back: 3, opacity: 0.03},
];

const Chip: React.FC<{spec: ChipSpec}> = ({spec}) => {
  const frame = useCurrentFrame();
  const now = chipAt(spec, frame);
  if (now.t >= 1 || now.t <= 0) return null;
  return (
    <>
      {/* Subtle 3-frame fading trail */}
      {TRAIL.map(({back, opacity}) => {
        const g = chipAt(spec, frame - back);
        if (g.t <= 0 || g.t >= 1) return null;
        return (
          <div
            key={back}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              transform: `translate(${g.x}px, ${g.y}px) translate(-50%, -50%) scale(${g.scale})`,
              opacity,
            }}
          >
            <ChipBody name={spec.name} />
          </div>
        );
      })}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transform: `translate(${now.x}px, ${now.y}px) translate(-50%, -50%) scale(${now.scale})`,
        }}
      >
        <ChipBody name={spec.name} />
      </div>
    </>
  );
};

const Orb: React.FC<{chips: ChipSpec[]}> = ({chips}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  // The OrbWhip overlay takes over from here (match cut into the chat dot).
  if (frame >= ORB_HIDE_AT) return null;
  const {s: born} = snap(frame, fps, 1);
  let arrived = 0;
  let bump = 0;
  for (const c of chips) {
    const af = c.start + c.dur;
    if (frame >= af) {
      arrived++;
      const dt = frame - af;
      if (dt < 12) bump += 0.055 * Math.exp(-dt / 3.5);
    }
  }
  const scale = born * (1 + 0.45 * (arrived / chips.length) + bump);
  const base = 150;
  // Lilac glow blooms with each absorption pulse.
  const glow = Math.min(bump * 4, 0.4);
  return (
    <div
      style={{
        position: 'absolute',
        left: ORB.x - base / 2,
        top: ORB.y - base / 2,
        width: base,
        height: base,
        borderRadius: '50%',
        transform: `scale(${scale})`,
        background:
          'radial-gradient(circle at 35% 30%, #C4AEFF 0%, #8B5CF6 45%, #6C3BFF 100%)',
        boxShadow: `0 0 ${70 + glow * 160}px ${26 + glow * 70}px rgba(167,139,250,${0.55 + glow}), 0 0 ${180 + glow * 260}px ${90 + glow * 110}px rgba(167,139,250,${0.28 + glow * 0.6})`,
      }}
    />
  );
};

// Kinetic word: spring snap + 2-frame motion blur as it lands.
const KineticWord: React.FC<{text: string; start: number}> = ({
  text,
  start,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const w = snap(frame, fps, start);
  const blur = interpolate(frame, [start, start + 2.5], [9, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        fontSize: 128,
        fontWeight: 800,
        color: C.ink,
        letterSpacing: '-0.03em',
        lineHeight: 1.04,
        filter: blur > 0.1 ? `blur(${blur}px)` : undefined,
        ...snapStyle(w.s, w.o, 46),
      }}
    >
      {text}
    </div>
  );
};

/** The corner slot the pulled-back settings page is framed into. */
const ERUPTION_CARD = {w: 620, h: 470};

export interface SceneEruptionProps {
  /** The two kinetic-type lines, bottom-left. Line 2 carries the blank. */
  lines: [string, string];
  /** The host settings row the agent capability was just switched on from. */
  feature: {title: string; subtitle: string};
  /** What gets inhaled into the orb. Defaults to the knowledge corpus. */
  files?: string[];
}

export const SceneEruption: React.FC<SceneEruptionProps> = ({
  lines,
  feature,
  files = DEFAULT_ERUPTION_FILES,
}) => {
  const frame = useCurrentFrame();
  const chips = useMemo(() => buildChips(files), [files]);

  return (
    <AbsoluteFill style={{backgroundColor: C.bg}}>
      <AbsoluteFill style={{transform: `scale(${pushIn(frame, 57)})`}}>
        {/* The same page, pulled back into the console's corner: Cadence's
            real settings column (../cadence/settings.tsx), the capability now
            switched on. Scaled and clipped to the corner slot — the film frames
            it; the host still owns every pixel inside. */}
        <div
          style={{
            position: 'absolute',
            left: 110,
            top: 110,
            width: ERUPTION_CARD.w,
            height: ERUPTION_CARD.h,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: CADENCE_COL_WIDTH,
              transform: `scale(${ERUPTION_CARD.w / CADENCE_COL_WIDTH})`,
              transformOrigin: 'top left',
            }}
          >
            <CadenceSettingsCard
              sectionLabel="Workspace settings"
              feature={feature}
              flipAt={-100}
              mark={<VendoMark size={13} />}
            />
          </div>
        </div>

        <Orb chips={chips} />
        {chips.map((c) => (
          <Chip key={c.name} spec={c} />
        ))}

        {/* Kinetic type, bottom-left, above the chip storm */}
        <div style={{position: 'absolute', left: 110, top: 645, zIndex: 10}}>
          <KineticWord text={lines[0]} start={24} />
          <KineticWord text={lines[1]} start={33} />
        </div>

        <Cursor
          path={[
            {frame: 0, x: 700, y: 260},
            {frame: 24, x: 1020, y: 560, bulge: -90},
            {frame: 51, x: 1130, y: 500, bulge: 50},
          ]}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

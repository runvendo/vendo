import React from 'react';
import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {CAD} from '../cadence/tokens';
import {
  CADENCE_COL_WIDTH,
  CADENCE_TOGGLE_INSET,
  CadenceSettingsCard,
} from '../cadence/settings';
import {Cursor} from '../template/Cursor';
import {VendoMark} from '../template/ui';

// Frames 0-24. Cold open, camera zoomed close on the host's own settings page:
// Cadence's real `max-w-3xl` settings column at its real 13px/12px row
// typography, its real Card/CardHeader/Row markup and its real ink toggle.
// See ../cadence/settings.tsx for the line-by-line provenance.
//
// Cursor is mid-descent at frame 0 and clicks the toggle at frame 8, which is
// where the detonation is pinned (Detonation.tsx CLICK).
const FLIP_AT = 8;

/** The pinned click point, in screen px. The camera's origin is this point, so
 *  the toggle stays here at any zoom and the detonation still starts on it. */
const TOGGLE = {x: 1560, y: 512};

/**
 * The camera. Cadence is authored for a browser column — 13px body text — so a
 * 1080p frame of it at 1:1 would be unreadable from a feed. The film solves that
 * the way a screen recording does: it zooms in. The magnification lives ENTIRELY
 * here, in a CSS scale, so every value inside the card stays the host's own.
 *
 * The camera law from the prototype is unchanged in shape: a slow drift across
 * the scene (the same +1.3%) times a 6-frame punch-in on the click.
 */
const ZOOM_FROM = 2.0;
const ZOOM_TO = 2.027;

/** Column placement, so the toggle's centre lands exactly on TOGGLE. */
const COL_LEFT = TOGGLE.x - (CADENCE_COL_WIDTH - CADENCE_TOGGLE_INSET);
/** Calibrated against a render: the offset from the column's top to the centre
 *  of the first row's toggle (page header + card header + half a row). */
const COL_TOP = TOGGLE.y - 152;

export interface SceneClickProps {
  /** The settings card the row lives under (its `CardHeader` title). */
  sectionLabel: string;
  /** The agent capability being switched on — this is the episode's subject. */
  feature: {title: string; subtitle: string};
  /** The greyed-out row below, which sells that this is a real settings page. */
  nextFeature: {title: string; subtitle: string};
}

export const SceneClick: React.FC<SceneClickProps> = ({
  sectionLabel,
  feature,
  nextFeature,
}) => {
  const frame = useCurrentFrame();

  const punch =
    interpolate(frame, [0, 18], [ZOOM_FROM, ZOOM_TO], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }) *
    interpolate(frame, [FLIP_AT, FLIP_AT + 6], [1, 1.08], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });

  return (
    <AbsoluteFill style={{backgroundColor: CAD.surface}}>
      <AbsoluteFill
        style={{
          transform: `scale(${punch})`,
          transformOrigin: `${TOGGLE.x}px ${TOGGLE.y}px`,
        }}
      >
        <div style={{position: 'absolute', left: COL_LEFT, top: COL_TOP}}>
          <CadenceSettingsCard
            sectionLabel={sectionLabel}
            feature={feature}
            nextFeature={nextFeature}
            flipAt={FLIP_AT}
            mark={<VendoMark size={13} />}
          />
        </div>
      </AbsoluteFill>

      {/* The cursor lives OUTSIDE the camera: its path is in screen px and its
          glyph is a real pointer, so a 2x camera must not draw a 2x cursor. */}
      <Cursor
        path={[
          {frame: -7, x: 1760, y: 310},
          {frame: FLIP_AT, x: TOGGLE.x, y: TOGGLE.y, click: true, bulge: 46},
          {frame: 24, x: TOGGLE.x + 14, y: TOGGLE.y + 16, bulge: -14},
        ]}
      />
    </AbsoluteFill>
  );
};

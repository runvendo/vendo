import React from 'react';
import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {C, cardStyle} from '../template/theme';
import {Cursor} from '../template/Cursor';
import {Toggle, VendoMark} from '../template/ui';

// Frames 0-24. Cold open, zoomed close on a settings card.
// Cursor is mid-descent at frame 0, clicks the toggle at frame 8.
const TOGGLE = {x: 1560, y: 512};

export interface SceneClickProps {
  /** The settings section the row lives under. */
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

  // Camera punch-in on click: 6 frames, 1.0 -> 1.08, centered on the click.
  // Base zoom drifts 1.12 -> 1.135 across the scene (camera law: never static).
  const punch =
    interpolate(frame, [0, 18], [1.12, 1.135], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }) *
    interpolate(frame, [8, 14], [1, 1.08], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });

  return (
    <AbsoluteFill style={{backgroundColor: C.bg}}>
      <AbsoluteFill
        style={{
          transform: `scale(${punch})`,
          transformOrigin: `${TOGGLE.x}px ${TOGGLE.y}px`,
        }}
      >
        {/* Settings card, zoomed close */}
        <div
          style={{
            ...cardStyle,
            position: 'absolute',
            left: 190,
            top: 268,
            width: 1540,
            height: 640,
          }}
        >
          {/* Section header, partially establishing a real settings page */}
          <div
            style={{
              position: 'absolute',
              left: 84,
              top: 62,
              fontSize: 26,
              fontWeight: 600,
              color: C.muted,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            {sectionLabel}
          </div>

          {/* The Knowledge row */}
          <div style={{position: 'absolute', left: 84, top: 176}}>
            <div style={{display: 'flex', alignItems: 'center', gap: 22}}>
              <VendoMark size={56} />
              <div
                style={{
                  fontSize: 64,
                  fontWeight: 700,
                  color: C.ink,
                  letterSpacing: '-0.03em',
                }}
              >
                {feature.title}
              </div>
            </div>
            <div
              style={{
                marginTop: 16,
                fontSize: 30,
                fontWeight: 400,
                color: C.muted,
              }}
            >
              {feature.subtitle}
            </div>
          </div>

          {/* Enable label + toggle */}
          <div
            style={{
              position: 'absolute',
              right: 96,
              top: 208,
              display: 'flex',
              alignItems: 'center',
              gap: 28,
            }}
          >
            <div style={{fontSize: 28, fontWeight: 500, color: C.body}}>
              Enable
            </div>
            <Toggle flipAt={8} scale={1.6} />
          </div>

          {/* Divider + hint of the next row (cropped feel) */}
          <div
            style={{
              position: 'absolute',
              left: 84,
              right: 84,
              top: 400,
              height: 1,
              backgroundColor: 'rgba(14,11,26,0.07)',
            }}
          />
          <div style={{position: 'absolute', left: 84, top: 452}}>
            <div
              style={{
                fontSize: 44,
                fontWeight: 700,
                color: C.ink,
                letterSpacing: '-0.03em',
                opacity: 0.35,
              }}
            >
              {nextFeature.title}
            </div>
            <div
              style={{
                marginTop: 12,
                fontSize: 26,
                color: C.muted,
                opacity: 0.55,
              }}
            >
              {nextFeature.subtitle}
            </div>
          </div>
        </div>

        <Cursor
          path={[
            {frame: -7, x: 1760, y: 310},
            {frame: 8, x: TOGGLE.x, y: TOGGLE.y, click: true, bulge: 46},
            {frame: 24, x: TOGGLE.x + 14, y: TOGGLE.y + 16, bulge: -14},
          ]}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

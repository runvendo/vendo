import React from 'react';
import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {CHAT_START, LIFT_AT, WIDGET, widgetPickup} from './chatShared';
import {FILM_Z} from './theme';
import {VendoStage} from './VendoStage';
import {Turn, viewTurn, weeklyUsagePayload} from '../scenes/agent-surface';

// SHARED-ELEMENT TRAVEL, chat → dashboard. Global-frame overlay.
// The finished view LIFTS off the chat (shadow deepens, scale 1.03), then
// flies along a curved path into its slot in the host dashboard — which the
// camera pullback has just revealed — landing with a spring squash.
//
// The thing in flight is the REAL app card, not a drawing of it: the same
// component and the same payload as the chat and the dashboard render, drawn
// at its natural width and scaled along the path. Only geometry is animated,
// so the shared element really is the same element at both ends of the cut.

const PICK = CHAT_START + LIFT_AT; // 240
const FLY0 = 248;
const FLY1 = 264;
const LAND1 = 266; // squash frames 264-265, then the dashboard card takes over

/** The card's slot in the host dashboard, in screen px (post-scroll).
 *  SceneProofC renders the landed card at exactly this rect. */
export const SLOT = {x: 1094, y: 300, w: 780, h: 430};

/** The card is authored at the chat's width and scaled, so the layout never
 *  reflows mid-flight. */
const NATURAL_W = WIDGET.w;

const FLYING_VIEW = weeklyUsagePayload(
  {stats: true, chart: true, schedule: true},
  false,
);

export const WidgetFlight: React.FC = () => {
  const frame = useCurrentFrame();
  if (frame < PICK || frame >= LAND1) return null;

  const pick = widgetPickup();

  // Lift: 240-248 — rise, scale 1.03, shadow deepens.
  const lift = interpolate(frame, [PICK, FLY0], [0, 1], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Flight: 248-264 — curved path into the slot.
  const p = interpolate(frame, [FLY0, FLY1], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const sx = pick.cx;
  const sy = pick.cy - 14 * lift;
  const tx = SLOT.x + SLOT.w / 2;
  const ty = SLOT.y + SLOT.h / 2;
  const ctrlX = (sx + tx) / 2 + 40;
  const ctrlY = Math.min(sy, ty) - 240;
  const u = 1 - p;
  const cx = u * u * sx + 2 * u * p * ctrlX + p * p * tx;
  const cy = u * u * sy + 2 * u * p * ctrlY + p * p * ty;

  const w = interpolate(p, [0, 1], [pick.w, SLOT.w]);
  const h = interpolate(p, [0, 1], [pick.h, SLOT.h]);
  const liftScale = 1 + 0.03 * lift * (1 - p);

  // Landing squash: scaleY 0.96 for the last 2 frames.
  const squash = frame >= FLY1 ? 0.96 : 1;

  // Shadow deepens while in motion, settles as it lands.
  const motion = Math.max(lift, p > 0 && p < 1 ? 1 : 0) * (1 - p * 0.5);
  const shadow = `0 ${6 + 18 * motion}px ${32 + 26 * motion}px rgba(108,59,255,${
    0.13 + 0.12 * motion
  })`;

  // Slight blur at flight speed peak.
  const flyBlur = p > 0.25 && p < 0.75 ? 2 : 0;

  return (
    <AbsoluteFill style={{zIndex: FILM_Z.flight, pointerEvents: 'none'}}>
      <div
        style={{
          position: 'absolute',
          left: cx - w / 2,
          top: cy - h / 2,
          width: w,
          height: h,
          borderRadius: 12,
          boxShadow: shadow,
          overflow: 'hidden',
          transform: `scale(${liftScale}) scaleY(${squash})`,
          transformOrigin: 'center bottom',
          filter: flyBlur ? `blur(${flyBlur}px)` : undefined,
        }}
      >
        <div
          style={{
            width: NATURAL_W,
            transform: `scale(${w / NATURAL_W})`,
            transformOrigin: 'top left',
          }}
        >
          <VendoStage>
            <Turn
              message={viewTurn('flying-view', 'weekly-usage', FLYING_VIEW)}
            />
          </VendoStage>
        </div>
      </div>
    </AbsoluteFill>
  );
};

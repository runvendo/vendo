import {interpolate, spring} from 'remotion';
import {SPRING_CFG} from './theme';

// Shared geometry + motion math for the continuous chat scene (frames 75-252)
// and the two global overlays that cross its cuts (OrbWhip, WidgetFlight).
// All frame arguments here are CHAT-LOCAL (global - CHAT_START).

export const CHAT_START = 75;
export const CHAT_DUR = 177;

export const CARD = {x: 400, y: 110, w: 1120, h: 860};

// Center of the violet "Assistant" status dot in the panel header
// (padding 22px 32px, dot 12px, row height ~29px).
export const DOT = {x: CARD.x + 32 + 6, y: CARD.y + 22 + 15};

// The panel slides up into place from this offset.
export const PANEL_SLIDE = 240;

// Chat-local frame at which the whip overlay hands the dot to the panel.
export const DOT_HANDOFF = 12;

// The generated view's rect. Width and position are the film's; the HEIGHT is
// the real component's, measured off a render: inside the overlay the product
// renders an in-thread view as a compact preview capped at
// PREVIEW_MAX_HEIGHT = 300 (packages/ui/src/chrome/thread/parts.tsx), so the
// real `.fl-appcard` is 760x342, not the prototype's invented 508. The flight
// overlay picks the card up from exactly this rect.
export const WIDGET = {x: CARD.x + 48, y: CARD.y + 236, w: 760, h: 342};

// Chat-local frame at which the widget hands off to the flight overlay.
export const LIFT_AT = 165;

// Chat fade-back (recede under the incoming dashboard).
export const FADE0 = 169;
export const FADE1 = 177;

export const panelRise = (local: number, fps: number) => {
  if (local <= 0) return PANEL_SLIDE;
  const s = spring({frame: local, fps, config: SPRING_CFG});
  return (1 - s) * PANEL_SLIDE;
};

// Camera: global push-in law (1.00 -> 1.03) times the answer push
// (1.00 -> 1.05 as message A's answer lands, easing back during the scroll).
export const chatCam = (local: number) => {
  const base = 1 + 0.03 * Math.min(Math.max(local / CHAT_DUR, 0), 1);
  const push =
    local < 70
      ? interpolate(local, [46, 70], [1, 1.05], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : interpolate(local, [70, 86], [1.05, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
  return base * push;
};

// Screen-space rect of the widget at the moment the flight overlay picks it
// up, accounting for the chat camera scale around screen center.
export const widgetPickup = () => {
  const cam = chatCam(LIFT_AT);
  const cx = 960 + (WIDGET.x + WIDGET.w / 2 - 960) * cam;
  const cy = 540 + (WIDGET.y + WIDGET.h / 2 - 540) * cam;
  return {cx, cy, w: WIDGET.w * cam, h: WIDGET.h * cam};
};

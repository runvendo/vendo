import type {VendoTheme} from '@vendoai/core';
import {C} from './theme';

/**
 * The brand tokens the REAL @vendoai/ui components are themed with on camera.
 *
 * Everything the chrome sheet paints derives from these (themeCssVariables in
 * packages/ui/src/theme.ts flattens them to --vendo-*), so this is the whole
 * brand surface — there is no per-component styling anywhere in the studio.
 *
 * Two values are load-bearing for video rather than for product:
 *  - `baseSize` is the anchor of the chrome type scale. The product ships 15px
 *    for a browser at arm's length; a 1080p frame watched in a feed needs the
 *    whole surface stepped up, and this is the designed knob for it.
 *  - `motion: "reduced"` zeroes --vendo-motion-duration, which switches off the
 *    components' own wall-clock CSS transitions. The film drives every entrance
 *    from useCurrentFrame() instead, so renders are deterministic and the
 *    approved prototype pacing is what actually plays.
 */
export const videoVendoTheme: Partial<VendoTheme> = {
  colors: {
    background: C.white,
    surface: C.softFill,
    text: C.ink,
    muted: C.muted,
    accent: C.violet,
    accentText: C.white,
    danger: '#C62F2F',
    border: '#E7E4F0',
  },
  typography: {
    fontFamily: 'Onest, system-ui, -apple-system, sans-serif',
    baseSize: '26px',
  },
  radius: {small: '8px', medium: '12px', large: '16px'},
  density: 'comfortable',
  motion: 'reduced',
};

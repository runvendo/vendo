/**
 * Cadence's real design tokens.
 *
 * Copied verbatim from the host's own stylesheet —
 * apps/demo-accounting/src/app/globals.css (the "Porcelain Ledger" @theme
 * blocks) and apps/demo-accounting/.vendo/theme.json. Nothing here is
 * eyeballed. Cadence is a Tailwind v4 CSS-first app with no config file, so
 * these custom properties ARE the design system; the studio cannot run its
 * PostCSS pipeline, so it reads the same values as constants.
 *
 * If Cadence rebrands, this file is the single place the film follows it.
 */

/** globals.css @theme — brand (ledger green, data-only) */
export const EVERGREEN = {
  50: '#e7f4ee',
  100: '#d3ebdf',
  200: '#abd8c4',
  300: '#7cbfa2',
  400: '#4c9f7d',
  500: '#1e7f53',
  600: '#196b46',
  700: '#15573a',
  800: '#124630',
  900: '#0e3726',
  950: '#08211a',
} as const;

/** globals.css @theme — porcelain neutrals & ink */
export const CAD = {
  surface: '#fbfbfa',
  card: '#ffffff',
  line: '#ecebe8',
  lineStrong: '#dfddd8',
  ink: '#111111',
  inkSoft: '#46443f',
  inkFaint: '#908c85',
} as const;

/** globals.css @theme — status (document/deadline state only) */
export const STATUS = {
  missing: '#a16207',
  missingBg: '#faf3e3',
  overdue: '#b0473a',
  overdueBg: '#fbede9',
  review: '#3555c8',
  reviewBg: '#eaeefb',
  verified: '#1e7f53',
  verifiedBg: '#e7f4ee',
} as const;

/** globals.css @theme — elevation ("barely-there ink") */
export const SHADOW = {
  card: '0 1px 2px rgb(17 17 17 / 0.04)',
  pop: '0 1px 3px rgb(17 17 17 / 0.05), 0 8px 24px rgb(17 17 17 / 0.07)',
} as const;

/** .vendo/theme.json radius scale. Cards are `rounded-xl` = 12px in markup. */
export const RADIUS = {small: 6, medium: 12, large: 12} as const;

/**
 * Cadence loads Inter (UI) and Manrope (wordmark) through next/font. The studio
 * has no Next runtime, so it declares the same families and lets the chrome's
 * inlined stack resolve them; the CSS variable names are kept because several
 * Cadence components reference them by name.
 */
export const CAD_FONT =
  'Inter, var(--font-inter), ui-sans-serif, system-ui, sans-serif';
export const CAD_BRAND_FONT =
  'Manrope, var(--font-manrope), ui-sans-serif, system-ui, sans-serif';

/**
 * The film renders 1920x1080; Cadence is authored for a browser column at
 * ~13px body text. Every Cadence px value below is multiplied by this so the
 * proportions stay exactly the host's while the type is legible in a feed.
 */
export const CAD_SCALE = 1.62;

export const cad = (px: number): number => Math.round(px * CAD_SCALE);

/** Real nav, in the host's own order — apps/demo-accounting/src/components/shell/sidebar.tsx */
export const CAD_NAV: Array<{group?: string; items: string[]}> = [
  {items: ['Dashboard', 'Ask Cadence']},
  {group: 'Workspace', items: ['Clients', 'Work', 'Calendar', 'Inbox']},
  {group: 'Firm', items: ['Team', 'Integrations', 'Settings']},
];

/** The firm the demo host is seeded with (src/server/seed.ts). */
export const CAD_FIRM = 'Hartwell & Associates';
export const CAD_SEASON = 'Tax season 2026';

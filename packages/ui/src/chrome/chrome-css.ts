import { ONEST_FONT_CSS } from "./onest-font.gen.js";

/** The ported Vendo shell stylesheet (design system). Generated from the
 *  wave-2 shell; tokens bridged to the VendoTheme contract. Onest (the brand
 *  font, defaultVendoTheme's first family) rides along as inlined @font-face
 *  data so the unthemed default look renders it with zero host setup — hosts
 *  that set their own fontFamily simply never reference it. */
export const CHROME_CSS = ONEST_FONT_CSS + `/* @vendoai/ui chrome — the S1 design language (2026-08-03), a RECIPE over the
   frozen VendoTheme contract. Every aesthetic token below is DERIVED from the
   contract brand tokens (--vendo-color-*, --vendo-radius-*, --vendo-font-*)
   that themeCssVariables() emits: S1 fixes the RELATIONSHIPS (hairline borders
   at ~8% of the foreground, the radius scale as multiples of radius.medium,
   muted-text mixing, shadow only on floating elements), never the palette. A
   warm-branded host renders warm S1; a neutral host renders neutral S1.
   The frosted-glass identity is retired: surfaces are flat. */
.vendo-root {
  /* ENG-226: scheme derived from the luminance of the theme's colors.background
     (themeCssVariables emits --vendo-color-scheme) — a dark-brand host flips
     every light-dark() branch below to its designed dark value. */
  color-scheme: var(--vendo-color-scheme, light);
  /* brand → shell token bridge */
  --vendo-fg: var(--vendo-color-text, #14151a);
  /* Muted is pulled ~40% toward the text color so small muted labels
     (.fl-picker-group, .fl-voice-status, captions) clear WCAG AA 4.5:1 on the
     glass surfaces — in BOTH schemes, since text always contrasts the bg. */
  --vendo-fg-muted: color-mix(in srgb, var(--vendo-color-muted, #8a8b92) 45%, var(--vendo-color-text, #14151a));
  --vendo-bg: var(--vendo-color-background, #f3ede2);
  --vendo-surface: var(--vendo-color-surface, #fffdf9);
  --vendo-accent: var(--vendo-color-accent, #1b1c22);
  --vendo-accent-fg: var(--vendo-color-accent-text, #ffffff);
  /* S1 hairline: felt, not seen. Derived as ~8% of the foreground rather than
     read from colors.border, so the edge always sits the same distance from the
     text in ANY brand and in both schemes (a host's literal border color could
     not do that). colors.border is consequently unread by the chrome. */
  --vendo-border: color-mix(in srgb, var(--vendo-color-text, #14151a) 8%, transparent);
  --vendo-radius: var(--vendo-radius-medium, 12px);
  /* radius.small / radius.large were emitted by the theme but never read — only
     medium drove the whole sheet. Bridge them so small chrome (chips, badges,
     inline code, icon buttons) picks up radius.small and large surfaces
     (panels, sheets, pickers, connect card) pick up radius.large. */
  --vendo-radius-sm: var(--vendo-radius-small, 7px);
  --vendo-radius-lg: var(--vendo-radius-large, 16px);
  /* S1 radius scale as MULTIPLES of radius.medium (default 10px → 14/26px), so a
     square-brand host (radius.medium: 0) stays square everywhere. */
  --vendo-radius-card: calc(var(--vendo-radius) * 1.4);
  --vendo-radius-composer: calc(var(--vendo-radius) * 2.6);
  --vendo-font: var(--vendo-font-family, inherit);
  /* headingFamily was contract-listed but unread by the chrome; falls back to
     the body font when the host doesn't set a distinct heading face. */
  --vendo-heading-font: var(--vendo-heading-family, var(--vendo-font));
  /* Type scale anchored on the theme baseSize (08 §2) so a host's baseSize
     scales the primary reading text (turns, composer, hero), not only the root
     font-size. The .933 ratio preserves the historical 14px-on-15px-base size. */
  --vendo-base-size: var(--vendo-font-size, 15px);
  --vendo-text-body: calc(var(--vendo-base-size) * 0.933);
  /* System mono stack (no unshipped brand font): the chrome has no contract
     mono token, so this is the single themeable source referenced everywhere. */
  --vendo-font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  /* derived aesthetics */
  --vendo-accent-soft: color-mix(in srgb, var(--vendo-accent) 8%, transparent);
  --vendo-border-strong: color-mix(in srgb, var(--vendo-fg) 14%, transparent);
  /* WCAG 1.4.11 (non-text contrast, 3:1) — the S1 hairline is deliberately
     felt-not-seen, which is fine for a divider and NOT fine for the only mark
     that tells you which conversation is open, which rail row is selected, or
     whether a switch is off. Those marks derive one step up: ~50% of the
     foreground mixed into the background, which clears 3:1 against both the
     background and the surface in either scheme, and is still nothing but the
     host's own tokens. Never used for decoration. */
  --vendo-indicator: color-mix(in srgb, var(--vendo-fg) 50%, var(--vendo-bg));
  /* The ONE shadow, and it only ever paints elements that FLOAT above the
     surface: the composer card, toasts, hovered tiles, popovers/menus, the
     launcher pill and the overlay panel. Every resting surface is flat. */
  --vendo-shadow-float: 0 1px 2px color-mix(in srgb, var(--vendo-fg) 5%, transparent),
    0 10px 28px color-mix(in srgb, var(--vendo-fg) 8%, transparent);
  /* M2 motion (spec §6): one unhurried duration + one iOS-sheet easing. Named
     apart from the theme's --vendo-motion-* pair, which themeCssVariables emits
     INLINE on the root (an inline custom property beats this rule) and which
     drives the generated-view layer's 160ms hover transitions. */
  --vendo-duration: 380ms;
  --vendo-ease: cubic-bezier(0.32, 0.72, 0, 1);
  --vendo-ok: #2e9e6b;
  --vendo-danger: var(--vendo-color-danger, #b0392b);
  --vendo-danger-bg: color-mix(in srgb, var(--vendo-danger) 8%, var(--vendo-surface));
  --vendo-danger-border: color-mix(in srgb, var(--vendo-danger) 32%, var(--vendo-border));
  /* Warn / ceremony amber family — single source. The amber was scattered as
     raw literals across ceremony buttons, voice consent and the a11y hardening
     block; collapsed here so it is themeable from one place. Every dark-side
     value and the AA-safe on-fill text (ENG-226) are preserved exactly. */
  --vendo-warn: light-dark(#7a5000, #d9a94e);
  --vendo-warn-text: light-dark(#8a6a2e, #d9a94e);
  --vendo-warn-edge: #b3822f;
  /* DEAD as of Lane B: the .fl-btn-critical alias it existed for is gone
     (critical IS ceremony now) and nothing reads this token. It survives only
     because test/theme-tokens.test.tsx pins its amber literal to exactly one
     definition — retire that pin and this token together. */
  --vendo-warn-fill-critical: light-dark(#a97e2f, #b3822f);
  --vendo-warn-on-fill: light-dark(#fff, #14151a);
  --vendo-warn-tint: #f0b429;
  --vendo-warn-bg: color-mix(in srgb, var(--vendo-warn-tint) 12%, var(--vendo-surface));
  --vendo-warn-border: color-mix(in srgb, var(--vendo-warn-tint) 32%, var(--vendo-border));
  /* Neutral user bubble (ENG-227): raw accent painting the whole user turn read
     as iMessage-blue on a mostly-white host. A subtle fg-tinted surface reads
     as "mine" in both schemes (fg + surface both flip with the scheme) and
     reserves accent for the send button, focus rings and true accents. */
  --vendo-user-bubble: color-mix(in srgb, var(--vendo-fg) 7%, var(--vendo-surface));
  --vendo-user-bubble-fg: var(--vendo-fg);
  color: var(--vendo-fg);
  background: var(--vendo-bg);
  font-family: var(--vendo-font);
  font-size: var(--vendo-font-size, 15px);
  letter-spacing: -.011em;
  line-height: 1.5;
}
.vendo-root *, .vendo-root *::before, .vendo-root *::after { box-sizing: border-box; }
.vendo-root[data-vendo-motion="reduced"] * { animation: none !important; transition: none !important; }
/* The root joins the host's height chain (ENG-212). When it directly hosts a
   height-filling surface (thread or page — each declares height:100%;
   min-height:0), the root must forward the host's bounded height instead of
   sitting as an unconstrained block between the host's pane and the surface —
   otherwise .fl-msglist never gets a bounded height, nothing scrolls, and
   under an overflow:hidden host the composer and approval actions clip below
   the fold. Flex (not a bare height) so the automatic policy notice, when
   present above the surface, shares the space instead of pushing the surface
   past it. In an unbounded host the percentage resolves against an auto-height
   parent and everything sizes to content exactly as before. Overlay, slot and
   palette roots mount fixed/inline children and are deliberately NOT matched;
   the voice stage is left to the voice-v1 stage-layout work (it commonly
   mounts as a sibling of a thread — see Maple /vendo — where claiming 100%
   would carve the pane in half). */
.vendo-root:has(> .fl-thread), .vendo-root:has(> .fl-page) {
  display: flex; flex-direction: column; height: 100%; min-height: 0; }

/* ---------- thread shell ---------- */
/* min-width floor (ENG-228): squeezed host columns (Cadence at 375px) were
   collapsing the thread to one character per line — hold a readable floor and
   let the host column scroll instead. Capped at 100vw so viewports narrower
   than the floor never get horizontal overflow from us. */
.fl-thread { display: flex; flex-direction: column; height: 100%; min-height: 0;
  min-width: min(280px, 100vw); }
/* Positioned wrapper so the "jump to latest" button stays fixed to the viewport
   of the list instead of scrolling away with the content. */
.fl-msglist-wrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column;
  animation: fl-fade-in .18s ease; }
.fl-msglist { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 14px; padding: 18px 16px 10px; scrollbar-width: none;
  /* Faint top fade hints at scrollable history above (the scrollbar is hidden). */
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 14px);
  mask-image: linear-gradient(180deg, transparent 0, #000 14px); }
/* A single short turn rests just above the composer (auto collapses to 0 once the
   thread overflows, so long threads scroll normally) — no dead gap at the bottom. */
.fl-msglist > :first-child { margin-top: auto; }
/* The list scrolls; its children must never compress. Without this, any child
   with overflow:hidden (activity panels, rendered view cards) has a zero flex
   minimum and gets crushed to its borders the moment the thread overflows. */
.fl-msglist > * { flex-shrink: 0; }
.fl-msglist::-webkit-scrollbar { display: none; }
/* Every thread item enters fluidly (M2: blur-to-focus + rise) instead of
   popping — tool panels, approvals, connect cards, turns alike. Render-view
   slots are excluded: FluidReveal already morphs those. */
@media (prefers-reduced-motion: no-preference) {
  /* ENG-218 — entrance-animation gating on restore: turns present when a long
     thread is reopened carry .fl-no-entrance (set in chrome/thread), so only
     turns that ARRIVE after restore (streamed replies, sends) run the rise.
     A reopened 200-turn thread no longer fires 200 animations on first paint —
     which is also what makes the blur affordable: at most a couple of items
     rasterize at a time. */
  .fl-msglist > :not(.fl-reveal):not(.fl-no-entrance) { animation: fl-item-in var(--vendo-duration) var(--vendo-ease) both; }
}
@keyframes fl-item-in {
  from { opacity: 0; transform: translateY(10px); filter: blur(5px); }
  to   { opacity: 1; transform: none; filter: blur(0); } }
@keyframes fl-fade-in { from { opacity: 0; } to { opacity: 1; } }
/* ENG-218 — "show N earlier messages": reveals the deferred head of a windowed
   long thread. Sits at the top of the list, centered, quiet until hovered. */
.fl-load-older { align-self: center; margin: 2px auto 4px; padding: 5px 12px; cursor: pointer;
  font: inherit; font-size: .82em; color: var(--vendo-fg-muted); background: var(--vendo-surface);
  border: 1px solid var(--vendo-border); border-radius: 999px; transition: color .12s, border-color .12s; }
.fl-load-older:hover { color: var(--vendo-fg); border-color: var(--vendo-border-strong); }
/* ENG-218 — expand/collapse control for a huge single message (assistant or
   user). Reads as a quiet inline text button under the truncated body. */
.fl-more { display: inline-block; margin-top: 6px; padding: 0; cursor: pointer; font: inherit;
  font-size: .88em; font-weight: 550; color: var(--vendo-accent); background: none; border: 0;
  text-decoration: underline; text-underline-offset: 2px; }
.fl-turn-user .fl-more { color: inherit; opacity: .8; }
/* Visually-hidden live region — announces only the settled assistant turn. */
.fl-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
/* Jump to latest — appears only when scrolled up from the bottom. */
.fl-jump { position: absolute; right: 14px; bottom: 12px; width: 34px; height: 34px; border-radius: 50%;
  display: grid; place-items: center; cursor: pointer; color: var(--vendo-fg);
  border: 1px solid var(--vendo-border-strong); background: var(--vendo-surface);
  box-shadow: var(--vendo-shadow-float); animation: fl-fade-in .15s ease; transition: border-color .12s; }
.fl-jump:hover { border-color: var(--vendo-accent); }
.fl-jump:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 2px; }
/* Connect dock (ENG-205): the in-bar connect-tools entry. The .fl-dock
   wrapper hosts the ripple; the anchor positions the liquid tray over the bar. */
.fl-dock { position: relative; display: inline-flex; }
/* The ripple wrapper is the clip box (button rounding); the badge overhangs
   it, so it lives on the outer .fl-dock instead. */
.fl-dock-ripple { display: inline-flex; border-radius: 10px; }
.fl-dock-btn { position: relative; gap: 3px; }
.fl-dock-badge { position: absolute; top: -3px; right: -3px; min-width: 15px; height: 15px;
  border-radius: 999px; background: var(--vendo-ok); color: #fff; font-size: 10px;
  font-weight: 700; line-height: 15px; text-align: center; padding: 0 3px;
  z-index: 1; pointer-events: none;
  box-shadow: 0 0 0 2px var(--vendo-surface); }
/* Flex column so the composer's top margin never collapses out of the anchor:
   the anchor's top is then always exactly 10px above the bar's border edge,
   on every surface (page, overlay, slot), and the tray can dock flush. */
.fl-dock-anchor { position: relative; display: flex; flex-direction: column; }
/* Bottom-justified so the panel grows out of the bar edge while the entrance
   spring clamps its height. --fl-tray-max is set at open time to the room
   actually above the bar within this surface (page, overlay, or slot panel),
   so the tray never runs off the top — the picker scrolls internally instead.
   Docked flush onto the composer (one interface): the tray's bottom edge sits
   on the bar's top border, top corners match the bar's 14px, bottom corners
   square into the seam. */
.fl-tray { position: absolute; bottom: calc(100% - 10px); left: 16px; right: 16px;
  z-index: 30; transform-origin: bottom center; overflow: hidden; border-radius: 14px 14px 0 0;
  display: flex; flex-direction: column; justify-content: flex-end; }
/* The tray blooms out of the bar edge instead of popping: rise + un-shrink
   anchored at the seam, the same easing family as the item entrance. Exit is
   the reverse, shorter — the composer keeps it mounted (data-closing) until
   the animation has run, then squares its corners back via its own radius
   transition. Guarded by the media query (plus the data-vendo-motion="reduced"
   kill-switch above) so reduced-motion users get the old instant tray. */
@media (prefers-reduced-motion: no-preference) {
  .fl-tray { animation: fl-tray-open var(--vendo-duration) var(--vendo-ease) both; }
  .fl-tray[data-closing] { animation: fl-tray-close .18s cubic-bezier(.4, 0, 1, 1) both; }
}
.fl-tray[data-closing] { pointer-events: none; }
@keyframes fl-tray-open { from { opacity: 0; transform: translateY(12px) scaleY(.96); } }
@keyframes fl-tray-close { to { opacity: 0; transform: translateY(10px) scaleY(.97); } }
/* While the tray is up (incl. its exit animation) the bar squares its top
   corners so the two read as one card; the bar's top border is the seam. */
.fl-dock-anchor:has(.fl-tray) .fl-composer { border-top-left-radius: 0; border-top-right-radius: 0; }
/* Opaque elevated sheet: the tray floats over display text (the hero greet,
   thread turns), and even a few percent of translucency reads big dark glyphs
   straight through. Depth comes from the border + shadow, not glass. */
.fl-tray .fl-picker { max-height: min(420px, 48vh, var(--fl-tray-max, 9999px));
  background: var(--vendo-surface);
  border-radius: 14px 14px 0 0; border-bottom: 0;
  /* Fill the tray exactly: the standalone picker's 560px cap + flex-start
     would leave a dead strip beside the bar whenever the bar is wider. */
  max-width: none; align-self: stretch; }
/* No bottom scrim: the row clipped at the seam is the scroll cue. */

/* Host-component thread items (Connect card): same geometry as the render slot
   but no morph machinery — the shared item entrance is their only motion. */
.fl-uihost { align-self: stretch; width: 100%; }
/* A turn carrying a generated view must fill the column, not shrink-to-fit:
   the assistant bubble is normally align-self:flex-start (sized to its text),
   which makes a child view's width:100% resolve circularly to content width —
   collapsing streaming skeletons to a sliver. Stretch the turn so the view
   (and its forming skeletons) occupy the full width from the first frame. */
.fl-turn-assistant:has(.fl-uihost) { align-self: stretch; max-width: 100%; width: 100%; }

/* App boundary: the generated view sits inside a titled frame so it reads as a
   discrete piece of software, cleanly separated from the surrounding chat.
   Flat (S1): the hairline is the boundary, not a shadow — the card rests on the
   thread, it does not float above it. */
.fl-appcard { border: 1px solid var(--vendo-border); border-radius: var(--vendo-radius-card); overflow: hidden;
  background: var(--vendo-surface);
  /* Breathing room when the settled card scrolls its top into view. */
  scroll-margin-top: 10px; }
.fl-appcard-bar { display: flex; align-items: center; gap: 8px; padding: 9px 13px;
  border-bottom: 1px solid var(--vendo-border);
  background: color-mix(in srgb, var(--vendo-surface) 92%, var(--vendo-fg) 8%); }
.fl-appcard-dot { width: 8px; height: 8px; border-radius: 999px; flex: none;
  background: var(--vendo-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vendo-accent) 16%, transparent);
  transition: width .2s ease, margin-right .2s ease, opacity .2s ease; }
/* The dot narrates the BUILD only — once the view is ready it fades and
   collapses (margin swallows the flex gap), leaving just the app's name. */
.fl-appcard-bar[data-state="ready"] .fl-appcard-dot { opacity: 0; width: 0; margin-right: -8px;
  box-shadow: none; }
.fl-appcard-name { font: 600 12.5px/1 var(--vendo-font); color: var(--vendo-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fl-appcard-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }

/* Approval→notification morph: a floating card (same material as the overlay)
   that travels to the top-right on a GPU transform.
   The layer must stay transparent — it carries .vendo-root (which paints a
   surface bg) and is full-viewport, so a background here whites out the page. */
.fl-morph-layer { position: fixed; inset: 0; z-index: 2147483003; pointer-events: none; background: none; }
.fl-morph-card { display: flex; align-items: center; gap: 11px; box-sizing: border-box;
  padding: 11px 15px; overflow: hidden; transform-origin: top left; will-change: transform, width, height, opacity;
  border: 1px solid var(--vendo-border-strong); border-radius: var(--vendo-radius-card);
  background: var(--vendo-surface);
  box-shadow: 0 20px 48px color-mix(in srgb, var(--vendo-fg) 22%, transparent); }
.fl-morph-live { position: relative; width: 9px; height: 9px; flex: 0 0 9px; border-radius: 999px;
  background: var(--vendo-accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--vendo-accent) 15%, transparent); }
.fl-morph-copy { min-width: 0; flex: 1; }
.fl-morph-title { overflow: hidden; color: var(--vendo-fg); font: 720 13px/1.2 var(--vendo-font);
  text-overflow: ellipsis; white-space: nowrap; }
.fl-morph-sub { overflow: hidden; margin-top: 3px; color: var(--vendo-fg-muted); font: 400 12px/1.2 var(--vendo-font);
  text-overflow: ellipsis; white-space: nowrap; }
.fl-morph-logo { display: inline-grid; width: 32px; height: 32px; flex: none; place-items: center;
  border: 1px solid var(--vendo-border); border-radius: 10px; background: var(--vendo-surface); }

/* Render slot (ENG-205): the persistent wrapper a skeleton and its replacing
   view share, so the reveal can morph. The column layout + 14px gap mirror the
   message list so wrapping changes nothing about spacing; the exiting overlay
   repeats it so the fading skeleton sits exactly where it was. */
.fl-reveal { position: relative; align-self: flex-start; width: 100%;
  display: flex; flex-direction: column; gap: 14px; }
.fl-reveal-enter { display: flex; flex-direction: column; width: 100%; }
.fl-reveal-exit { position: absolute; top: 0; left: 0; right: 0; pointer-events: none;
  display: flex; flex-direction: column; gap: 14px; }
@media (prefers-reduced-motion: no-preference) {
  /* Animate only genuine morphs (an exit layer is present) — first paint of a
     slot's ordinary content must not perform an entrance. Transform + opacity
     only (GPU-composited, smooth at any frame rate); the incoming component
     rises with a soft spring while the placeholder settles out beneath it. */
  .fl-reveal:has(.fl-reveal-exit) .fl-reveal-enter { animation: fl-reveal-in .55s cubic-bezier(.22, 1.15, .36, 1) both; }
  .fl-reveal-exit { animation: fl-reveal-out .4s cubic-bezier(.4, 0, .5, 1) both; }
}
@keyframes fl-reveal-in {
  0%   { opacity: 0; transform: translateY(8px) scale(.965); }
  55%  { opacity: 1; }
  100% { opacity: 1; transform: none; } }
@keyframes fl-reveal-out {
  0%   { opacity: 1; transform: none; }
  100% { opacity: 0; transform: scale(1.015); } }

/* Fill reveal (pick A, ui-lane-renderer 2026-07-19): a shape-derived
   silhouette already holds the incoming view's approximate geometry, so its
   arrival crossfades in place — no rise, no settle. Placed AFTER the .fl-reveal
   rules so the equal-specificity override wins by order. */
@media (prefers-reduced-motion: no-preference) {
  .fl-reveal-fill:has(.fl-reveal-exit) .fl-reveal-enter { animation: fl-fill-in .45s ease both; }
  .fl-reveal-fill .fl-reveal-exit { animation: fl-fill-out .45s ease both; }
}
@keyframes fl-fill-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes fl-fill-out { from { opacity: 1; } to { opacity: 0; } }

/* App boot bar (pick C, V2 indeterminate sweep): while a generated view is
   still forming, the label reads "Building your view…" and a short accent
   segment sweeps along the bar's bottom edge. On ready the label pair
   crossfades to the app name and the sweep fades. Honest by design: no fake
   percentage, no completion jump. The label pair shares one grid cell so the
   swap never remounts.
   BUILD CALM (spec §8): the sweeping hairline is the ONLY animated element
   anywhere in the card while it builds — the dot rests, the beat orbs rest,
   the skeleton rests. One moving thing reads as work; four read as noise. */
.fl-appcard-bar { position: relative; }
.fl-boot-labels { position: relative; display: grid; min-width: 0; flex: 1; }
.fl-boot-labels > span { grid-area: 1 / 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: opacity .3s ease; }
.fl-appcard-bar[data-state="building"] .fl-boot-ready { opacity: 0; }
.fl-appcard-bar[data-state="ready"] .fl-boot-building { opacity: 0; }
.fl-boot-building { color: var(--vendo-fg-muted); font-weight: 500; }
.fl-boot-hairline { position: absolute; left: 0; bottom: -1px; z-index: 1; width: 26%; height: 2px;
  border-radius: 2px; background: var(--vendo-accent); opacity: 0; transition: opacity .5s ease; }
.fl-appcard-bar[data-state="building"] .fl-boot-hairline { opacity: 1; }
@media (prefers-reduced-motion: no-preference) {
  .fl-appcard-bar[data-state="building"] .fl-boot-hairline { animation: fl-boot-sweep 1.5s cubic-bezier(.45, .05, .55, .95) infinite; }
}
@keyframes fl-boot-sweep { from { transform: translateX(-110%); } to { transform: translateX(495%); } }

/* Working indicator — fluidkit metaball droplets (ENG-205); inherits the muted
   foreground as the flat-material fill. The .fl-typing dots below are its
   first-paint and no-fluidkit fallback. */
.fl-thinking { align-self: flex-start; color: var(--vendo-fg-muted); padding: 4px 2px; }
/* Typing indicator — three pulsing dots while the agent is working. */
.fl-typing { align-self: flex-start; display: flex; align-items: center; gap: 5px; padding: 4px 2px; }
.fl-typing span { width: 7px; height: 7px; border-radius: 50%; background: var(--vendo-fg-muted);
  animation: fl-typing 1.1s ease-in-out infinite; }
.fl-typing span:nth-child(2) { animation-delay: .18s; }
.fl-typing span:nth-child(3) { animation-delay: .36s; }
@keyframes fl-typing { 0%, 60%, 100% { opacity: .25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }

.fl-turn-user { position: relative; align-self: flex-end; background: var(--vendo-user-bubble); color: var(--vendo-user-bubble-fg);
  padding: 9px 14px; border-radius: var(--vendo-radius-lg) var(--vendo-radius-lg) var(--vendo-radius-sm) var(--vendo-radius-lg);
  max-width: 82%; font-size: var(--vendo-text-body); line-height: 1.5;
  letter-spacing: -.006em; border: 1px solid var(--vendo-border); }
.fl-usertext { white-space: pre-wrap; word-break: break-word; }
.fl-turn-assistant { align-self: flex-start; max-width: 92%; line-height: 1.65; font-size: var(--vendo-text-body); letter-spacing: -.006em; }
/* Space a turn's parts (beats, the app card, text) so the app boundary reads
   as its own block instead of butting against the beat above and the line
   below. Beats hug (their own 3px padding); the app card gets real air. */
.fl-turn-assistant > .fl-appcard { margin: 10px 0; }
/* The in-thread automation card (data-vendo-automation) gets the same air. */
.fl-turn-assistant > .fl-automation { margin: 10px 0; }
/* Lone caret while a streamed turn is still empty (stable line box, no jitter). */
.fl-caret { display: inline-block; width: 7px; min-height: 1.05em; height: 1.05em; background: var(--vendo-accent);
  vertical-align: -2px; margin-left: 2px; border-radius: 1px; animation: fl-blink 1s steps(1) infinite; }
/* Once text is flowing, the caret trails the last block as a pseudo-element so it
   stays inline instead of dropping onto its own line below the final paragraph. */
.fl-md--streaming > :last-child::after { content: ""; display: inline-block; width: .5em; height: 1.05em;
  margin-left: 2px; vertical-align: -2px; background: var(--vendo-accent); border-radius: 1px;
  animation: fl-blink 1s steps(1) infinite; }
@keyframes fl-blink { 50% { opacity: 0; } }
/* §8's one-animation law, made true in the frame it is actually broken in: a
   turn that is streaming PROSE while its app card builds ran two loops at once
   (blinking caret + gliding hairline), and a forming markdown table added a
   third. While any card in this thread is building, the hairline is the only
   moving thing — the caret still marks the insertion point, it just stops
   flashing. */
.fl-thread:has(.fl-appcard-bar[data-state="building"]) .fl-caret,
.fl-thread:has(.fl-appcard-bar[data-state="building"]) .fl-md--streaming > :last-child::after,
.fl-thread:has(.fl-appcard-bar[data-state="building"]) .fl-skeleton-bar { animation: none; }

/* ---------- markdown ---------- */
.fl-md > :first-child { margin-top: 0; }
.fl-md > :last-child { margin-bottom: 0; }
.fl-md p { margin: 0 0 8px; }
/* Explicit list-style: host CSS resets (Tailwind preflight) set none globally
   and the thread renders in the host's cascade, eating the bullets. */
.fl-md ul, .fl-md ol { margin: 0 0 8px; padding-left: 20px; }
.fl-md ul { list-style: disc; }
.fl-md ol { list-style: decimal; }
.fl-md li { margin: 2px 0; }
.fl-md li > p { margin: 0; }
.fl-md h1, .fl-md h2, .fl-md h3, .fl-md h4 { margin: 10px 0 6px; font-weight: 650; line-height: 1.3;
  font-family: var(--vendo-heading-font); }
.fl-md h1 { font-size: 1.15em; } .fl-md h2 { font-size: 1.08em; } .fl-md h3 { font-size: 1em; }
.fl-md a { color: var(--vendo-accent); text-decoration: underline; text-underline-offset: 2px; }
.fl-md strong { font-weight: 650; }
.fl-md code { font-family: var(--vendo-font-mono); font-size: .9em; background: var(--vendo-accent-soft);
  border: 1px solid var(--vendo-border); border-radius: var(--vendo-radius-sm); padding: 1px 5px; }
.fl-md pre { background: var(--vendo-accent-soft); border: 1px solid var(--vendo-border); border-radius: 11px;
  padding: 11px 13px; overflow-x: auto; margin: 0 0 8px; }
.fl-md pre code { background: none; border: 0; padding: 0; font-size: .85em; }
/* Code block with a hover Copy button. */
.fl-codeblock { position: relative; margin: 0 0 8px; }
.fl-codeblock pre { margin: 0; }
.fl-copy { position: absolute; top: 7px; right: 7px; font: 500 11px/1 var(--vendo-font); padding: 4px 8px;
  border-radius: 7px; border: 1px solid var(--vendo-border); color: var(--vendo-fg-muted);
  background: var(--vendo-surface);
  cursor: pointer; opacity: 0; transition: opacity .12s, color .12s; }
.fl-codeblock:hover .fl-copy, .fl-copy:focus-visible { opacity: 1; }
.fl-copy:hover { color: var(--vendo-fg); }
.fl-md blockquote { margin: 0 0 8px; padding-left: 10px;
  border-left: 2px solid var(--vendo-border-strong); color: var(--vendo-fg-muted); }
.fl-md table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; font-size: .92em; margin: 0 0 8px; }
.fl-md th, .fl-md td { border: 1px solid var(--vendo-border); padding: var(--vendo-density-table-padding); text-align: left; }
.fl-md img { max-width: 100%; height: auto; border-radius: 8px; }
.fl-md hr { border: 0; border-top: 1px solid var(--vendo-border); margin: 10px 0; }
.fl-turn-user .fl-md a, .fl-turn-user .fl-md code { color: inherit; border-color: var(--vendo-border); }

@keyframes fl-pulse { 0%,100% { opacity: .28; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
/* The shimmer bar, shared by the markdown table's forming row. */
.fl-skeleton-bar { background: linear-gradient(90deg,
    color-mix(in srgb, var(--vendo-fg) 5%, transparent) 25%,
    color-mix(in srgb, var(--vendo-fg) 10%, transparent) 37%,
    color-mix(in srgb, var(--vendo-fg) 5%, transparent) 63%);
  background-size: 400% 100%; animation: fl-shimmer 1.5s ease infinite; border-radius: 6px; }
@keyframes fl-shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

/* ---------- skeleton ground: a view taking shape ---------- */
/* The frosted recipe is retired (S1): a forming view rests on the same flat
   surface + hairline every other card uses, so a skeleton and the view that
   replaces it read as one object. */
.fl-glass { border-radius: var(--vendo-radius-card); padding: var(--vendo-density-card-padding);
  background: var(--vendo-surface); border: 1px solid var(--vendo-border); }
/* Placeholder blocks: the HOST ACCENT at a flat .10 (light) / .16 (dark) tint.
   STATIC by design (spec §8 build calm) — a skeleton can sit on screen for
   seconds while a plan fills in, and the app bar's hairline already says
   "working"; a second sweeping loop only competes with it. */
.fl-glass-shimmer { border-radius: var(--vendo-radius);
  background: light-dark(color-mix(in srgb, var(--vendo-accent) 10%, transparent),
    color-mix(in srgb, var(--vendo-accent) 16%, transparent)); }

/* ---------- build beats (the thread's human progress voice) ----------
   One quiet line per tool call: pulsing orb while working, tick when done,
   loud only on error. The mechanical record lives in the Activity panel. */
/* Beats stack as one connected checklist: tight, even rhythm, no per-item
   collapse. Consecutive beats hug (2px) so the group reads as a single block;
   completed lines quiet to muted, the active one carries the pulsing orb. */
.fl-beat { align-self: flex-start; display: flex; align-items: center; gap: 9px;
  font: 500 13px/1.35 var(--vendo-font); color: var(--vendo-fg-muted); padding: 3px 2px; }
@media (prefers-reduced-motion: no-preference) {
  .fl-beat { animation: fl-fade-in .24s ease both; }
}
.fl-beat-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Static (spec §8 build calm): the trailing "…" on the label carries the
   working state; the orb is a position marker, not a heartbeat. */
.fl-beat-orb { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
  background: radial-gradient(circle at 35% 35%,
    color-mix(in srgb, var(--vendo-accent) 55%, var(--vendo-surface) 45%), var(--vendo-accent)); }
.fl-beat-ic { display: grid; place-items: center; width: 12px; height: 12px; flex-shrink: 0; }
/* The in-flight beat keeps full-strength text; settled ones quiet to muted. */
.fl-beat-working { color: var(--vendo-fg); }
.fl-beat-done { color: var(--vendo-fg-muted); }
.fl-beat-tick { color: var(--vendo-ok); }
.fl-beat-error { color: var(--vendo-danger); }
.fl-beat-x { color: var(--vendo-danger); }
.fl-beat-count { margin-left: 2px; padding: 1px 6px; border-radius: 999px; flex-shrink: 0;
  font: 600 10.5px/1.4 var(--vendo-font); color: var(--vendo-fg-muted);
  border: 1px solid var(--vendo-border); background: var(--vendo-surface); }
/* A terminally failed app build: the ✕ beat plus the classified reason,
   indented under it. Prose, not a failure component (spec §15) — no card, no
   retry chrome; the agent's next sentence carries the recovery. */
.fl-buildfail { align-self: flex-start; }
/* A failure headline is CONTENT: it wraps rather than ellipsizing. The beat's
   nowrap clip is right for a progress line and wrong here, and TWO rules hid
   the sentence together — a turn is shrink-to-fit (.fl-turn-assistant is
   align-self: flex-start), so this block's former 92% max-width resolved
   against a width its own text had just set, making the box 8% narrower than
   the headline inside it, and the ellipsis ate the end. A persisted failure
   with no detail line under it read "The response didn't f…" after a reload
   (PR #864 proof). The turn already caps at 92% of the list. */
.fl-buildfail .fl-beat-label { overflow: visible; white-space: normal; text-overflow: clip; }
.fl-buildfail .fl-approval-more { margin-left: 21px; line-height: 1.5; }

/* The tool chip was replaced by the build beats above; only its error line
   survives (the voice consent bar's inline failure text). */
.fl-tool-err { color: var(--vendo-danger); }
@keyframes fl-spin { to { transform: rotate(360deg); } }

/* ---------- approval / buttons ---------- */
.fl-approval { align-self: flex-start; border: 1px solid var(--vendo-border);
  border-radius: var(--vendo-radius-card); padding: 16px;
  background: var(--vendo-surface);
  max-width: 88%; min-width: min(360px, 88%); }
.fl-automation-approval-slot { align-self: flex-start; width: 100%; display: flex; }
.fl-approval-fields { margin: 12px 0 0; padding: 10px 0 2px; border-top: 1px solid var(--vendo-border);
  display: flex; flex-direction: column; gap: 7px; }
.fl-approval-field { display: grid; grid-template-columns: minmax(88px, auto) 1fr; gap: 12px;
  font-size: 12.5px; line-height: 1.45; }
.fl-approval-field dt { color: var(--vendo-fg-muted); }
/* pre-line: object/array inputs render as compact \`Key: value\` lines
   (field-rows.ts), one per line, instead of raw JSON. */
.fl-approval-field dd { margin: 0; color: var(--vendo-fg); overflow-wrap: anywhere; white-space: pre-line; }
.fl-approval-more { font-size: 11.5px; color: var(--vendo-fg-muted); }
/* Connect-card lifecycle (2026-07 demo feedback): the button spins while the
   OAuth window is open, then becomes a quiet permanent Connected badge. */
.fl-connect-spin { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; display: inline-block;
  border: 2px solid color-mix(in srgb, currentColor 35%, transparent); border-top-color: currentColor;
  animation: fl-spin .7s linear infinite; }
.fl-connect-done { display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px 5px 8px;
  border: 1px solid var(--vendo-border); border-radius: 999px;
  background: color-mix(in srgb, var(--vendo-accent) 7%, var(--vendo-surface));
  color: var(--vendo-fg); font: 600 12px/1 var(--vendo-font); }
.fl-connect-done-ic { display: inline-grid; place-items: center; width: 15px; height: 15px;
  border-radius: 999px; background: var(--vendo-accent); color: var(--vendo-accent-fg); }
.fl-connect-done-ic svg { width: 9px; height: 9px; }
/* Grant-set consent card (demo-live-readiness mockup §2): the enumerated
   permission rows under the standing-access head, and the settled outcome. */
.fl-grantset { min-width: min(420px, 88%); }
.fl-grants { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; }
.fl-grant { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; gap: 10px; align-items: center;
  padding: 9px 0; border-top: 1px solid color-mix(in srgb, var(--vendo-border) 68%, transparent); }
.fl-grant:first-child { border-top: 1px solid var(--vendo-border); }
.fl-grant-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.fl-grant-copy b { font: 600 12.8px/1.35 var(--vendo-font); color: var(--vendo-fg); overflow-wrap: anywhere; }
.fl-grant-copy span { color: var(--vendo-fg-muted); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.fl-grant-check { display: grid; place-items: center; color: var(--vendo-accent); }
.fl-grantset-outcome { display: flex; align-items: center; gap: 7px; margin-top: 12px; padding-top: 11px;
  border-top: 1px solid var(--vendo-border); font: 600 12.5px/1 var(--vendo-font); color: var(--vendo-fg); }
.fl-grantset[data-state="denied"] .fl-grantset-outcome { color: var(--vendo-fg-muted); font-weight: 500; }
.fl-automation-approval { padding: 16px; }
.fl-auto-details { margin-top: 8px; }
.fl-auto-details summary { color: var(--vendo-fg-muted); font-size: 11px; cursor: pointer; }
.fl-auto-details pre { margin: 7px 0 0; max-height: 180px; overflow: auto; white-space: pre-wrap;
  font: 11px/1.35 var(--vendo-font-mono); color: var(--vendo-fg-muted); }
/* "Automation is live" toast — floats, so it keeps a shadow. */
.fl-auto-created-toast { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 58px;
  box-sizing: border-box; padding: 11px 12px; border: 1px solid var(--vendo-border);
  border-radius: var(--vendo-radius-card); color: var(--vendo-fg); background: var(--vendo-surface);
  box-shadow: var(--vendo-shadow-float); }
.fl-auto-created-live { position: relative; width: 9px; height: 9px; flex: 0 0 9px; border-radius: 999px;
  background: var(--vendo-accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--vendo-accent) 15%, transparent); }
.fl-auto-created-live::after { position: absolute; inset: -4px; border: 1px solid color-mix(in srgb, var(--vendo-accent) 24%, transparent);
  border-radius: inherit; content: ""; animation: fl-auto-created-pulse 1.7s ease-out infinite; }
.fl-auto-created-copy { min-width: 0; flex: 1; }
.fl-auto-created-title { overflow: hidden; color: var(--vendo-fg); font-size: 13px; font-weight: 720;
  line-height: 1.18; text-overflow: ellipsis; white-space: nowrap; }
.fl-auto-created-sub { overflow: hidden; margin-top: 3px; color: var(--vendo-fg-muted); font-size: 12px;
  line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
@keyframes fl-auto-created-pulse {
  0% { opacity: .52; transform: scale(.7); }
  100% { opacity: 0; transform: scale(1.9); }
}
.fl-approval-batch-list { list-style: none; margin: 12px 0 0; padding: 10px 0 2px;
  border-top: 1px solid var(--vendo-border); display: flex; flex-direction: column; gap: 7px; }
.fl-approval-batch-row label { display: flex; align-items: center; gap: 9px;
  font-size: 12.5px; line-height: 1.45; color: var(--vendo-fg); cursor: pointer; }
.fl-approval-batch-row input[type="checkbox"] { appearance: none; margin: 0; width: 15px; height: 15px;
  flex-shrink: 0; border: 1px solid var(--vendo-border-strong); border-radius: 4.5px;
  background: var(--vendo-surface); cursor: pointer; display: grid; place-items: center;
  transition: background .13s, border-color .13s; }
.fl-approval-batch-row input[type="checkbox"]:hover { border-color: var(--vendo-accent); }
.fl-approval-batch-row input[type="checkbox"]:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 2px; }
.fl-approval-batch-row input[type="checkbox"]:checked { background: var(--vendo-accent); border-color: var(--vendo-accent); }
.fl-approval-batch-row input[type="checkbox"]:checked::after { content: ""; width: 8.5px; height: 8.5px;
  background: var(--vendo-accent-fg);
  clip-path: polygon(14% 44%, 0 62%, 40% 100%, 100% 18%, 84% 4%, 39% 68%); }
/* Buttons are flat (S1): the fill and the hairline carry the hierarchy.
   There is exactly ONE filled style, .fl-btn-primary, plus .fl-btn-ceremony
   for the destructive register. */
.fl-btn { border: 1px solid var(--vendo-border); border-radius: var(--vendo-radius); padding: 8px 15px;
  font: 550 12.5px/1 var(--vendo-font); letter-spacing: -.006em;
  /* Icon + label ride one non-wrapping row (a squeezed flex row used to fold
     the connect spinner onto its own line above the label). */
  display: inline-flex; align-items: center; justify-content: center; gap: 7px; white-space: nowrap;
  background: var(--vendo-surface); color: var(--vendo-fg); cursor: pointer;
  transition: background .13s, border-color .13s, transform .05s; }
.fl-btn:hover { background: var(--vendo-accent-soft); border-color: var(--vendo-border-strong); }
.fl-btn:active { transform: translateY(.5px); }
.fl-btn-primary { background: var(--vendo-accent); color: var(--vendo-accent-fg); border-color: transparent; }
.fl-btn-primary:hover { opacity: .92; background: var(--vendo-accent); border-color: transparent; }
/* Ceremony = the ONLY other filled button: destructive confirms. Its AA-safe
   fill/text pair per scheme is pinned in the a11y hardening block at the end. */
.fl-btn-ceremony { background: var(--vendo-warn); color: var(--vendo-warn-on-fill); border-color: transparent; }
.fl-btn-ceremony:hover { opacity: .92; background: var(--vendo-warn); border-color: transparent; }
.fl-btn-quiet { border-color: transparent; background: transparent;
  color: var(--vendo-fg-muted); padding: 8px 10px; }
.fl-btn-quiet:hover { background: var(--vendo-accent-soft); border-color: transparent; color: var(--vendo-fg); }
/* Inline button spinner (Reconnect) — tinted for a filled primary button. */
.fl-btn-spin { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
  border: 2px solid color-mix(in srgb, var(--vendo-accent-fg) 35%, transparent);
  border-top-color: var(--vendo-accent-fg); animation: fl-spin .7s linear infinite; }
.fl-approval-consequence { margin-top: 10px; font: 500 12px/1.4 var(--vendo-font); color: var(--vendo-warn-text); }

/* ---------- waiting list ("waiting on you", ENG-193 §4.6) ---------- */
/* Height-capped with internal scroll: an unbounded inbox (verified live with
   9 parked rows) starves the host page's flex column, compressing the thread
   until the last card's buttons sit UNDER the docked composer — whose form
   then intercepts their clicks. The strip must never take more than its
   share of the surface; overflow scrolls inside. */
.fl-waiting { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
  max-height: min(40vh, 360px); overflow-y: auto; overscroll-behavior: contain;
  border: 1px solid var(--vendo-border); border-radius: var(--vendo-radius);
  background: var(--vendo-surface); }
/* The scroller's children must never compress (same rule as .fl-msglist). */
.fl-waiting > * { flex-shrink: 0; }

/* ---------- composer ---------- */
/* Column so attachment chips / drop zone stack above the input row. */
.fl-composer { position: relative; display: flex; flex-direction: column; gap: 8px; margin: 10px 16px 16px;
  padding: 7px 8px 7px 14px;
  background: var(--vendo-surface);
  border: 1px solid var(--vendo-border); border-radius: var(--vendo-radius-composer);
  box-shadow: var(--vendo-shadow-float);
  transition: border-color .14s, box-shadow .14s, border-radius .2s ease; }
/* No focus ring on pointer focus (Apple/OpenAI-quiet): the caret is the
   signal. KEYBOARD focus still gets a visible ring via :focus-visible —
   the textarea keeps outline:0, so without this rule Tab-focus would be
   invisible on the product's primary input. */
.fl-composer:has(:focus-visible) { border-color: var(--vendo-border-strong);
  box-shadow: var(--vendo-shadow-float), 0 0 0 3px var(--vendo-accent-soft); }
/* align-items:flex-start so the text grows DOWNWARD from a fixed top edge and
   the controls stay where the user last saw them. flex-end (the old rule) was
   right for a one-line field and wrong for every other: the textarea's own text
   sits at ITS top, so past one line the row pushed the icons and Send down while
   the text stayed put — the field read as mis-centred and Send moved under the
   cursor mid-sentence. At one line the icon's 34px box and the text's 33px line
   box agree within half a pixel, so the collapsed composer is unchanged. */
.fl-composer-row { display: flex; align-items: flex-start; gap: 10px; }
.fl-composer textarea { flex: 1; border: 0; outline: 0; background: transparent; color: var(--vendo-fg);
  font-family: var(--vendo-font); font-size: var(--vendo-base-size); line-height: 1.5; resize: none; max-height: 200px;
  padding: 6px 0; overflow-y: auto; scrollbar-width: none; }
.fl-composer textarea::-webkit-scrollbar { display: none; }
.fl-composer textarea::placeholder { color: var(--vendo-fg-muted); }
.fl-icon-btn { flex-shrink: 0; width: 34px; height: 34px; border-radius: 10px; border: 1px solid transparent;
  background: transparent; display: flex; align-items: center; justify-content: center; cursor: pointer;
  color: var(--vendo-fg-muted); transition: background .12s, color .12s, opacity .12s; }
.fl-icon-btn:hover { background: var(--vendo-accent-soft); color: var(--vendo-fg); }
.fl-attach { color: var(--vendo-fg-muted); }

/* drag-over overlay */
.fl-drop { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; border-radius: 16px;
  border: 1.5px dashed var(--vendo-accent); background: color-mix(in srgb, var(--vendo-accent) 7%, var(--vendo-surface));
  font-size: 12.5px; font-weight: 550; color: var(--vendo-fg); }

/* attachment preview chips (in composer) */
.fl-att-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.fl-att-img { position: relative; width: 46px; height: 46px; border-radius: var(--vendo-radius-sm); overflow: hidden;
  border: 1px solid var(--vendo-border); }
.fl-att-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fl-att-file { display: inline-flex; align-items: center; gap: 8px; height: 46px; padding: 0 30px 0 10px; position: relative;
  border: 1px solid var(--vendo-border); border-radius: var(--vendo-radius-sm); background: var(--vendo-surface); font-size: 12px; max-width: 220px; }
.fl-att-ext { display: grid; place-items: center; width: 26px; height: 32px; border-radius: 4px; flex-shrink: 0;
  background: var(--vendo-danger); color: #fff; font: 700 8px/1 var(--vendo-font); letter-spacing: .02em; }
.fl-att-meta { display: flex; flex-direction: column; min-width: 0; }
.fl-att-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fl-att-meta small { color: var(--vendo-fg-muted); font-size: 10.5px; }
.fl-att-rm { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border-radius: 50%; border: 0;
  background: rgba(0,0,0,.6); color: #fff; font-size: 11px; line-height: 1; display: grid; place-items: center; cursor: pointer; }
.fl-att-rm-file { top: 50%; transform: translateY(-50%); background: var(--vendo-accent-soft); color: var(--vendo-fg); }
.fl-att-error { font-size: 11.5px; color: var(--vendo-danger); padding: 0 2px; }

/* queued-send pill (ENG-215): a message typed mid-turn parks here and auto-sends
   when the turn completes. Reads as a pending chip, not a sent bubble. */
.fl-queued { position: relative; display: flex; align-items: center; gap: 8px; padding: 7px 34px 7px 10px;
  border: 1px dashed var(--vendo-border-strong); border-radius: var(--vendo-radius-sm);
  background: var(--vendo-accent-soft); font-size: 12.5px; color: var(--vendo-fg); }
.fl-queued-tag { flex-shrink: 0; font: 600 10px/1 var(--vendo-font); text-transform: uppercase; letter-spacing: .04em;
  color: var(--vendo-accent); border: 1px solid color-mix(in srgb, var(--vendo-accent) 40%, transparent);
  border-radius: 5px; padding: 3px 5px; }
.fl-queued-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.fl-queued-hint { margin-left: auto; flex-shrink: 0; color: var(--vendo-fg-muted); font-size: 11px; }
.fl-queued-rm { background: var(--vendo-accent-soft); color: var(--vendo-fg); }

/* sent attachments (in transcript) */
.fl-turn-user-att { align-self: flex-end; max-width: 82%; display: flex; flex-wrap: wrap; gap: 6px;
  align-items: flex-start; justify-content: flex-end; }
.fl-msg-img { display: block; max-width: 160px; border-radius: 12px; overflow: hidden; border: 1px solid var(--vendo-border); }
.fl-msg-img img { display: block; max-width: 100%; height: auto; }
.fl-msg-file { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 12px; align-self: flex-start;
  border: 1px solid var(--vendo-border); background: var(--vendo-surface); font-size: 12.5px; color: var(--vendo-fg);
  text-decoration: none; max-width: 200px; }
.fl-msg-file .fl-att-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- activity panel ---------- */
.fl-act { align-self: flex-start; width: 100%; max-width: 92%; border: 1px solid var(--vendo-border);
  border-radius: var(--vendo-radius-card); background: var(--vendo-surface); overflow: hidden; }
.fl-act-head { display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px 13px; cursor: pointer;
  border: 0; background: transparent; font: 600 12.5px/1.2 var(--vendo-font); color: var(--vendo-fg); text-align: left; }
.fl-act-head:hover { background: var(--vendo-accent-soft); }
.fl-act-head-lbl { font-weight: 600; }
.fl-act-head-err { color: var(--vendo-danger); }
.fl-act-now { color: var(--vendo-fg-muted); font-weight: 500; }
.fl-act-chev { margin-left: auto; color: var(--vendo-fg-muted); font-size: 13px; transition: transform .15s; }
.fl-act-chev-open { transform: rotate(90deg); }
.fl-act-pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--vendo-accent); flex-shrink: 0;
  animation: fl-pulse 1.2s ease infinite; }
.fl-act-body { border-top: 1px solid var(--vendo-border); padding: 3px 0; }
.fl-act-row { display: flex; align-items: center; gap: 9px; padding: 8px 13px; font-size: 12.5px; }
.fl-act-lbl { font-weight: 550; }
.fl-act-sub { margin-left: auto; color: var(--vendo-fg-muted); font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 55%; }
.fl-act-err { color: var(--vendo-danger); }
.fl-act-ic { display: grid; place-items: center; width: 14px; height: 14px; font-size: 11px; flex-shrink: 0; }
.fl-act-tick { color: var(--vendo-ok); }
.fl-act-x { color: var(--vendo-danger); }
.fl-act-denied { color: var(--vendo-fg-muted); }
.fl-act-spin { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
  border: 2px solid var(--vendo-border-strong); border-top-color: var(--vendo-fg-muted); animation: fl-spin .8s linear infinite; }
.fl-act-cap { display: block; width: 100%; padding: 9px 13px 3px; text-align: left;
  color: var(--vendo-fg-muted); font-weight: 500; font-size: 11.5px; }
.fl-act-th { text-align: left; font-weight: 600; font-size: 10.5px; letter-spacing: .05em;
  text-transform: uppercase; color: var(--vendo-fg-muted); }
.fl-act-cell { min-width: 0; font-size: 12.5px; }
.fl-act-kind { display: inline-block; margin-right: 7px; padding: 1px 7px; border-radius: 999px;
  background: var(--vendo-accent-soft); border: 1px solid var(--vendo-border); color: var(--vendo-fg-muted);
  font-size: 10px; font-weight: 600; letter-spacing: .02em; vertical-align: 1px; }
.fl-act-action { font-weight: 550; }
.fl-act-detail { color: var(--vendo-fg-muted); font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fl-act-when { color: var(--vendo-fg-muted); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.fl-act-outcome { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.fl-act-by { margin-top: 2px; color: var(--vendo-fg-muted); font-size: 10.5px; }
.fl-act-foot { display: flex; align-items: center; padding: 10px 13px; }
.fl-act-end { margin: 0; color: var(--vendo-fg-muted); font-size: 11.5px; }
.fl-act-peek { margin: -2px 13px 9px 36px; border: 1px solid var(--vendo-border); border-radius: 9px; overflow: hidden; }
.fl-act-peek-row { display: flex; justify-content: space-between; gap: 10px; padding: 6px 10px; font-size: 11.5px;
  border-bottom: 1px solid var(--vendo-border); }
.fl-act-peek-row:last-child { border-bottom: 0; }
.fl-act-peek-k { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fl-act-peek-v { color: var(--vendo-fg-muted); font-variant-numeric: tabular-nums; flex-shrink: 0; }

/* ---------- turn actions ---------- */
.fl-turn-actions { display: flex; align-items: center; gap: 2px; margin-top: 6px;
  opacity: 0; transition: opacity .14s; }
.fl-turn-assistant:hover .fl-turn-actions,
.fl-turn-assistant:focus-within .fl-turn-actions,
.fl-turn-assistant:last-child .fl-turn-actions { opacity: 1; }
/* ENG-215 — the last user turn carries an Edit action; reveal on hover/focus so
   keyboard users reach it too (the button stays tabbable while faint).
   Overlaid BELOW the bubble, out of flow: in flow the invisible row reserved a
   whole blank line inside the bubble (it reads as a stray trailing newline).
   pointer-events gate so the hidden row never eats clicks in the list gap it
   overlays; hovering down onto the revealed row keeps :hover (it is still a
   descendant of the turn). */
.fl-turn-user .fl-turn-actions { justify-content: flex-end;
  position: absolute; top: calc(100% + 2px); right: 0; margin-top: 0; pointer-events: none; }
.fl-turn-user:hover .fl-turn-actions,
.fl-turn-user:focus-within .fl-turn-actions { opacity: 1; pointer-events: auto; }
.fl-turn-btn { display: inline-flex; align-items: center; gap: 5px; height: 27px; min-width: 27px; padding: 0 6px;
  border: 0; border-radius: 7px; background: transparent; color: var(--vendo-fg-muted); cursor: pointer;
  font: 550 12px/1 var(--vendo-font); transition: background .12s, color .12s; }
.fl-turn-btn:hover { background: var(--vendo-accent-soft); color: var(--vendo-fg); }
.fl-turn-btn:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 1px; }

/* ---------- markdown: tables + math ---------- */
.fl-md table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0; }
.fl-md th, .fl-md td { text-align: left; padding: var(--vendo-density-table-padding); border-bottom: 1px solid var(--vendo-border); }
.fl-md thead th { color: var(--vendo-fg-muted); font: 600 11px/1.3 var(--vendo-font);
  text-transform: uppercase; letter-spacing: .03em; }
.fl-md tbody tr:nth-child(even) { background: var(--vendo-accent-soft); }
.fl-md .katex-display { margin: 10px 0; overflow-x: auto; overflow-y: hidden; }

/* streaming: new blocks fade in as they arrive (subtle, per-block) */
.fl-md--streaming > * { animation: fl-fade-in .28s ease both; }
.fl-icon-btn:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 2px; }
.fl-icon-btn:disabled { opacity: .4; cursor: default; }
.fl-icon-btn:disabled:hover { background: transparent; }
.fl-send { border-radius: 50%; background: var(--vendo-accent); color: var(--vendo-accent-fg); border-color: transparent;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--vendo-fg) 22%, transparent), inset 0 1px 0 rgba(255,255,255,.16); }
.fl-send:hover { opacity: .92; background: var(--vendo-accent); color: var(--vendo-accent-fg); }
.fl-send:disabled:hover { opacity: .4; background: var(--vendo-accent); }

/* ---------- landing ---------- */
/* The landing is ONLY the greeting + starter cards: the composer renders as a
   sibling below (the same bottom slot it occupies in an active conversation),
   so sending the first message never moves it. Content centers in the free
   space and scrolls when the panel is shorter than the card stack. */
.fl-landing { display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 16px; flex: 1; min-height: 0; overflow-y: auto; padding: 30px 30px 10px; text-align: center; }
.fl-greet { margin: 0; font-family: var(--vendo-heading-font); font-size: calc(var(--vendo-base-size) * 1.533); font-weight: 600; letter-spacing: -.022em; }
/* The optional capability line under the landing headline (VendoThread's
   \`intro\` prop) — muted assistant voice, canvas geometry (max 460px). */
.fl-intro { margin: 0; max-width: 460px; font-size: var(--vendo-text-body); line-height: 1.65;
  letter-spacing: -.006em; color: var(--vendo-fg-muted); }
/* Greeting-as-tutorial (ui-usage-dx §6): the one-time first message reads as
   the agent speaking — left-aligned assistant typography with its prompt chips
   beneath — inside the otherwise-centered landing. */
.fl-greeting { display: flex; flex-direction: column; gap: 14px; align-self: stretch;
  max-width: 560px; margin: 0 auto; text-align: left; }
.fl-greeting-intro { margin: 0; line-height: 1.65; font-size: var(--vendo-text-body); letter-spacing: -.006em; }
.fl-greeting .fl-chips { justify-content: flex-start; }
.fl-chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
/* Mixed suggestions (cards + chips): the chips are the second tier, under an
   "Or try this" micro-label (demo-live-readiness mockup §1). */
.fl-try-row { margin-top: 16px; }
.fl-try-row .fl-chips { justify-content: flex-start; }
.fl-try-label { display: block; margin-bottom: 9px; font-size: 11px; font-weight: 600;
  letter-spacing: .08em; text-transform: uppercase; color: var(--vendo-fg-muted); }
.fl-chip { border: 1px solid var(--vendo-border); background: var(--vendo-surface);
  border-radius: 999px; padding: 8px 14px; font-size: 12.5px; color: var(--vendo-fg); cursor: pointer;
  transition: border-color .14s, background .14s, transform .18s cubic-bezier(.22,1,.36,1), box-shadow .18s; }
.fl-chip:hover { border-color: var(--vendo-border-strong); background: var(--vendo-surface);
  transform: translateY(-1px); box-shadow: 0 2px 10px color-mix(in srgb, var(--vendo-fg) 8%, transparent); }
.fl-chip:active { transform: translateY(0); box-shadow: none; }
/* Brand focus ring — the UA default blue halo is off-brand in every host. */
.fl-chip:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 2px; }
/* (No landing-specific composer wrapper: the landing renders the SAME
   bottom-pinned composer bar as an active conversation, so the first send
   causes no composer jump.) */

/* ---------- connection selector (denser, brand-forward) ---------- */
.fl-picker { border: 1px solid var(--vendo-border); border-radius: var(--vendo-radius-lg);
  background: var(--vendo-surface);
  box-shadow: var(--vendo-shadow-float); overflow: auto; padding: 18px 18px 20px; max-width: 560px;
  max-height: min(560px, 70vh); align-self: flex-start; width: 100%;
  scrollbar-width: none; }
.fl-picker::-webkit-scrollbar { display: none; }
.fl-picker-toprow { display: flex; align-items: center; gap: 8px; }
.fl-picker-toprow .fl-picker-search { flex: 1; width: auto; margin-bottom: 0; }
.fl-picker-close { margin-left: auto; width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center;
  border: 0; background: transparent; color: var(--vendo-fg-muted); cursor: pointer; transition: background .12s, color .12s; }
.fl-picker-close:hover { background: var(--vendo-accent-soft); color: var(--vendo-fg); }
.fl-picker-search { width: 100%; box-sizing: border-box; border: 1px solid var(--vendo-border); border-radius: 10px;
  outline: 0; background: var(--vendo-surface); font-family: var(--vendo-font); font-size: 13px;
  color: var(--vendo-fg); padding: 9px 11px; margin-bottom: 4px; }
.fl-picker-search::placeholder { color: var(--vendo-fg-muted); }
.fl-picker-group { font: 600 10.5px/1 var(--vendo-font); letter-spacing: .05em; text-transform: uppercase;
  color: var(--vendo-fg-muted); margin: 16px 2px 9px; }
.fl-picker-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; padding: 0; }
.fl-picker-item { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-radius: 11px;
  border: 1px solid var(--vendo-border); background: var(--vendo-surface); transition: transform .12s, border-color .12s, box-shadow .12s; }
.fl-picker-item:hover { transform: translateY(-1px); border-color: var(--vendo-border-strong); box-shadow: var(--vendo-shadow-float); }
.fl-picker-item.is-connected { background: color-mix(in srgb, var(--vendo-ok) 9%, var(--vendo-surface));
  border-color: color-mix(in srgb, var(--vendo-ok) 26%, var(--vendo-border));
  transition: transform .12s, border-color .35s cubic-bezier(.22,1,.36,1), box-shadow .12s, background .35s cubic-bezier(.22,1,.36,1); }
/* OAuth in flight: the + hands the status slot to a mini metaball loader. */
.fl-picker-connecting { display: inline-flex; align-items: center; color: var(--vendo-fg-muted);
  min-width: 19px; justify-content: center; }
.fl-picker-connecting .fl-typing span { width: 4px; height: 4px; }
/* Observed connect: the green wash blooms in and the dot lands with a soft
   ripple ring — a one-shot celebration; reopens render is-connected plain. */
.fl-picker-item.is-just-connected { animation: fl-connect-bloom .5s cubic-bezier(.22,1,.36,1) both; }
.fl-picker-item.is-just-connected .fl-picker-on { animation: fl-connect-pop .55s cubic-bezier(.22,1,.36,1) both; }
@keyframes fl-connect-bloom {
  from { background: var(--vendo-surface); border-color: var(--vendo-border); }
  to   { background: color-mix(in srgb, var(--vendo-ok) 9%, var(--vendo-surface));
         border-color: color-mix(in srgb, var(--vendo-ok) 26%, var(--vendo-border)); } }
@keyframes fl-connect-pop {
  0%   { transform: scale(0); box-shadow: 0 0 0 0 color-mix(in srgb, var(--vendo-ok) 45%, transparent); }
  55%  { transform: scale(1.35); }
  80%  { box-shadow: 0 0 0 8px color-mix(in srgb, var(--vendo-ok) 0%, transparent); }
  100% { transform: scale(1); box-shadow: 0 0 0 3px color-mix(in srgb, var(--vendo-ok) 16%, transparent); } }
.fl-picker-ic { width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; flex-shrink: 0;
  background: var(--vendo-surface); border: 1px solid var(--vendo-border); font-size: 11px; font-weight: 700; }
.fl-picker-nm { font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fl-picker-status { margin-left: auto; flex-shrink: 0; }
.fl-picker-on { width: 7px; height: 7px; border-radius: 50%; background: var(--vendo-ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vendo-ok) 16%, transparent); }
.fl-picker-add { width: 19px; height: 19px; border-radius: 50%; border: 1px solid var(--vendo-border-strong);
  display: grid; place-items: center; font-size: 13px; line-height: 1; color: var(--vendo-fg-muted); background: transparent; cursor: pointer; }
.fl-picker-item:hover .fl-picker-add { background: var(--vendo-accent); color: var(--vendo-accent-fg); border-color: var(--vendo-accent); }

/* ---------- in-conversation connect prompt ---------- */
/* Compact post-connect confirmation: a quiet status pill, not a display card. */
.fl-connect-done { display: inline-flex; align-items: center; gap: 9px; align-self: flex-start;
  border: 1px solid var(--vendo-border); border-radius: 999px; padding: 7px 14px 7px 9px;
  background: var(--vendo-surface); font-size: 12.5px; font-weight: 550; }

/* ---------- automation card ---------- */
.fl-automation { align-self: flex-start; width: 100%; border-radius: var(--vendo-radius); overflow: hidden;
  border: 1px solid var(--vendo-border); background: var(--vendo-surface); box-shadow: var(--vendo-shadow-float); }
.fl-auto-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; }
.fl-auto-ic { width: 34px; height: 34px; border-radius: 10px; background: var(--vendo-accent);
  color: var(--vendo-accent-fg); display: grid; place-items: center; flex-shrink: 0; }
.fl-auto-title { font-weight: 600; font-size: 14px; letter-spacing: -.01em; }
.fl-auto-sub { font-size: 11.5px; color: var(--vendo-fg-muted); margin-top: 2px; display: flex; align-items: center; gap: 6px; }
.fl-auto-live { width: 6px; height: 6px; border-radius: 50%; background: var(--vendo-ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vendo-ok) 16%, transparent); }
/* Grant-set wait state (mockup §2): enabled but permissions outstanding. */
.fl-auto-wait { background: var(--vendo-warn);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vendo-warn) 18%, transparent); }
/* §9.9 — why a stopped automation stopped. An accent border rather than another
   badge: it is one sentence of explanation, and the row above already carries
   the state word. Warn, not danger — nothing is broken, it is waiting. */
.fl-auto-stopped { border-left: 2px solid var(--vendo-warn); padding-left: 8px; margin-top: 6px;
  color: var(--vendo-fg); }
.fl-auto-toggle { margin-left: auto; width: 40px; height: 23px; border-radius: 999px; background: var(--vendo-accent);
  position: relative; flex-shrink: 0; border: 0; cursor: pointer; }
.fl-auto-toggle::after { content: ""; position: absolute; top: 2.5px; right: 2.5px; width: 18px; height: 18px;
  border-radius: 50%; background: var(--vendo-accent-fg); box-shadow: 0 1px 3px rgba(0,0,0,.22); }
.fl-auto-flow { display: flex; align-items: center; padding: 14px 16px 16px; border-top: 1px solid var(--vendo-border); }
.fl-auto-node { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 12px;
  background: var(--vendo-bg); border: 1px solid var(--vendo-border); }
.fl-auto-node-ic { width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center;
  background: var(--vendo-surface); border: 1px solid var(--vendo-border); }
.fl-auto-node-t { font-size: 12.5px; font-weight: 600; line-height: 1.2; }
.fl-auto-node-s { font-size: 11px; color: var(--vendo-fg-muted); margin-top: 1px; }
.fl-auto-arrow { flex: 1; min-width: 20px; height: 0; border-top: 1.5px dashed var(--vendo-border-strong);
  margin: 0 8px; position: relative; }
.fl-auto-arrow::after { content: ""; position: absolute; right: -1px; top: -4px; width: 7px; height: 7px;
  border-top: 1.5px solid var(--vendo-border-strong); border-right: 1.5px solid var(--vendo-border-strong); transform: rotate(45deg); }

/* ---------- overlay (clipping fixed: bounded height, scrolls) ---------- */
/* Portal wrapper: provides theme vars to the modal without generating a box. */
.fl-overlay-portal { display: contents; }
.fl-overlay-scrim { position: fixed; inset: 0; background: color-mix(in srgb, var(--vendo-fg) 22%, transparent); z-index: 2147483000;
  animation: fl-scrim-in .2s ease both; }
.fl-overlay-panel { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 2147483001;
  width: min(620px, 94vw); height: min(680px, 86vh); display: flex; flex-direction: column;
  background: var(--vendo-bg);
  border: 1px solid var(--vendo-border-strong); border-radius: var(--vendo-radius-lg); overflow: hidden;
  box-shadow: 0 30px 80px color-mix(in srgb, var(--vendo-fg) 24%, transparent);
  /* open animation — the "squeeze": a horizontal stretch out from a sliver, with a
     springy overshoot. transform-origin stays centered so it grows symmetrically. */
  transform-origin: center; animation: fl-overlay-stretch .5s cubic-bezier(.22, 1.2, .36, 1) both; }
.fl-overlay-close { position: absolute; top: 12px; right: 12px; z-index: 5; width: 28px; height: 28px;
  border-radius: 9px; display: grid; place-items: center; border: 0; background: transparent;
  color: var(--vendo-fg-muted); cursor: pointer; transition: background .12s, color .12s; }
.fl-overlay-close:hover { background: var(--vendo-accent-soft); color: var(--vendo-fg); }
/* ENG-221: new-conversation sits just left of the close X — same quiet header
   treatment (it shares .fl-overlay-close), only the horizontal offset differs.
   Offsets = close's right + close's width + a 6px gap, per pointer density. */
.fl-overlay-new { right: 46px; }
/* Compact when empty (ui-lane-entry pick P-C): while the thread shows its
   landing (no conversation yet), the panel is a smaller box — greeting,
   starter cards, the bottom-pinned composer, no dead glass — and animates to
   full height the moment the first turn lands (the landing swaps to the
   message list, :has stops matching). Browsers without :has() simply keep the
   full-size panel. Sized so a greeting plus TWO rows of starter cards (four
   cards) fit without clipping — hosts ship four scenario cards out of the
   box (2026-07 fix: was 360px, which clipped the wrapped second row). */
.fl-overlay-panel { transition: height .45s cubic-bezier(.22, 1, .36, 1), width .45s cubic-bezier(.22, 1, .36, 1); }
.fl-overlay-panel:has(.fl-landing) { height: min(500px, 80vh); }
.fl-overlay-panel:has(.fl-landing) .fl-landing { padding-top: 34px; }
@keyframes fl-scrim-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes fl-overlay-stretch {
  from { transform: translate(-50%, -50%) scaleX(.06) scaleY(.7); opacity: .4; }
  60%  { opacity: 1; }
  to   { transform: translate(-50%, -50%) scaleX(1) scaleY(1); opacity: 1; } }
/* ---------- split-view workspace (2026-07 demo feedback) ---------- */
/* The overlay's expandable workspace: the panel grows near-fullscreen, the
   featured microapp renders LARGE on a left stage (the leftover ~2/3) and the
   conversation docks as the right rail. One animated property does the pane
   work — the rail's flex-basis walks 100% ⇄ max(360px, 33.5%), so the stage
   (flex 1 1 0) grows exactly as the rail shrinks; the panel's own width/height
   ride the existing .45s spring. The thread's DOM slot is identical in both
   states (no remount — the ENG-221 invariant). */
.fl-split { flex: 1; min-height: 0; display: flex; align-items: stretch; }
.fl-split-stage { flex: 1 1 0; min-width: 0; overflow: hidden; display: flex; flex-direction: column;
  background: var(--vendo-bg); opacity: 0;
  border-right: 0 solid var(--vendo-border);
  transition: opacity .28s ease .1s, border-right-width 0s .45s; }
.fl-split-rail { flex: 0 0 100%; min-width: 0; display: flex; flex-direction: column;
  transition: flex-basis .45s cubic-bezier(.22, 1, .36, 1); }
.fl-overlay-panel[data-vendo-expanded] { width: min(1500px, 96vw); height: min(940px, 94vh); }
.fl-overlay-panel[data-vendo-expanded] .fl-split-rail { flex-basis: max(360px, 33.5%); }
.fl-overlay-panel[data-vendo-expanded] .fl-split-stage { opacity: 1; border-right-width: 1px;
  transition: opacity .28s ease .1s, border-right-width 0s; }
/* The stage: a quiet porcelain workspace — hairline-framed content, generous
   air, the same app-boundary vocabulary as the in-thread card. */
.fl-stage { flex: 1; min-height: 0; display: flex; flex-direction: column; animation: fl-fade-in .22s ease both; }
.fl-stage-bar { display: flex; align-items: center; gap: 8px; flex: none;
  padding: 13px 20px; border-bottom: 1px solid var(--vendo-border);
  font: 600 12.5px/1 var(--vendo-font); color: var(--vendo-fg-muted); letter-spacing: .01em;
  background: var(--vendo-surface); }
.fl-stage-name { color: var(--vendo-fg); font-size: 13px; }
.fl-stage-body { flex: 1; min-height: 0; overflow: auto; padding: 26px clamp(20px, 4vw, 48px) 32px; }
.fl-stage-empty { margin: auto; text-align: center; color: var(--vendo-fg-muted);
  font-size: 13px; line-height: 1.55; max-width: 340px; padding: 24px; display: grid; gap: 4px; }
.fl-stage-empty p { margin: 0; }
/* Header affordance: expand sits left of new-conversation (close 12 → new 46
   → expand 80; the mobile block below never shows it — the takeover owns
   small screens). A fresh embed landing while collapsed pulses it once. */
.fl-overlay-expand { right: 80px; }
@media (prefers-reduced-motion: no-preference) {
  .fl-overlay-expand[data-vendo-suggest] { animation: fl-suggest-pulse 1.4s ease 2; color: var(--vendo-accent); }
}
@keyframes fl-suggest-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--vendo-accent) 40%, transparent); }
  45% { box-shadow: 0 0 0 8px transparent; background: var(--vendo-accent-soft); } }
/* Compact in-chat embeds (2026-07 demo feedback): inside an overlay the
   in-thread card is a scaled-down PREVIEW — the app renders full-size on a
   fixed-width canvas and transform-scales to the card width, clamped short
   (~300px), inert (the stage is the interactive venue), with the Expand pill
   prominent. Inline styles carry the measured height/scale; this is the skin. */
.fl-appcard-preview { position: relative; overflow: hidden; padding: 0; display: block; }
.fl-appcard-canvas { transform-origin: top left; pointer-events: none;
  box-sizing: border-box; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.fl-appcard-fade { position: absolute; left: 0; right: 0; bottom: 0; height: 64px; pointer-events: none;
  background: linear-gradient(to bottom, transparent, color-mix(in srgb, var(--vendo-surface) 92%, transparent)); }
.fl-embed-expand { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
  display: inline-flex; align-items: center; gap: 6px; padding: 7px 13px; cursor: pointer;
  border: 1px solid var(--vendo-border-strong); border-radius: 999px;
  background: var(--vendo-surface);
  color: var(--vendo-fg); font: 600 11.5px/1 var(--vendo-font);
  box-shadow: 0 8px 22px color-mix(in srgb, var(--vendo-fg) 14%, transparent);
  transition: border-color .14s, transform .18s cubic-bezier(.22, 1, .36, 1); }
.fl-embed-expand:hover { border-color: var(--vendo-accent); transform: translateX(-50%) translateY(-1px); }
/* Staged = blurred in chat (2026-07): while this app is featured on the
   fullscreen stage, its preview blurs under a centered "Full screened" label
   (chrome type voice, no interaction) — collapse clears it. */
.fl-appcard-preview[data-vendo-staged] .fl-appcard-canvas { filter: blur(9px) saturate(.85); }
.fl-appcard-veil { position: absolute; inset: 0; display: grid; place-items: center;
  background: color-mix(in srgb, var(--vendo-surface) 45%, transparent);
  color: var(--vendo-fg-muted); font: 600 12.5px/1 var(--vendo-font); letter-spacing: .02em; }
/* Pin from fullscreen: the stage bar's action, same quiet pill as the card
   bar's pin (fl-barpin) pushed to the right edge. */
.fl-stage-pin { margin-left: auto; }

/* Rail app cards while the workspace is up: clickable to feature, and the
   featured one carries a quiet accent ring so "what's on stage" reads. */
.fl-appcard[data-vendo-featurable] { cursor: pointer; }
.fl-appcard[data-vendo-featured] { border-color: var(--vendo-accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--vendo-accent) 55%, transparent); }
/* The embed's shared-element flight (EmbedMorphGhost — MorphToast's ghost
   pattern): a static clone of the app frame flies rail-card ⇄ stage on the
   same spring as the panel, so the microapp GROWS out of the conversation
   instead of a pane resizing around it. Fixed above the panel (which clips
   overflow); inline styles carry the animated box, this is just the skin. */
.fl-embed-ghost { position: fixed; z-index: 2147483002; overflow: hidden; pointer-events: none;
  border-radius: 14px; border: 1px solid var(--vendo-border); background: var(--vendo-bg);
  box-shadow: 0 24px 70px color-mix(in srgb, var(--vendo-fg) 22%, transparent); }
.fl-embed-ghost-scale { transform-origin: top left; }
.fl-embed-ghost .fl-turn-actions, .fl-embed-ghost .fl-newbar { display: none; }
/* While the ghost flies IN, the real stage frame holds back and takes over
   right where the ghost lands (the fade-out/fade-in overlap masks the swap).
   While it flies OUT, the stage frame vanishes at once — its clone IS the
   visible surface for the whole collapse. */
.fl-overlay-panel[data-vendo-ghost="in"] .fl-stage { animation: fl-fade-in .2s ease both; animation-delay: .3s; }
.fl-overlay-panel[data-vendo-ghost="out"] .fl-stage { opacity: 0; animation: none; }
/* While the clone flies OUT of the rail, the REAL featured card dims — the
   card reads as lifting out, not duplicating; the base opacity transition
   restores it softly when the ghost unmounts. (On collapse the card stays
   lit: the clone visibly lands INTO it.) */
.fl-appcard { transition: opacity .22s ease; }
.fl-overlay-panel[data-vendo-ghost="in"] .fl-appcard[data-vendo-featured] { opacity: .3; }
/* The takeover is already the full-screen surface: expansion is inert there. */
.fl-overlay-panel.fl-takeover .fl-split-stage { display: none; }
.fl-overlay-panel.fl-takeover .fl-split-rail { flex-basis: 100%; }

@media (prefers-reduced-motion: reduce) {
  .fl-overlay-panel { animation: fl-overlay-fade .18s ease both; }
  @keyframes fl-overlay-fade { from { opacity: 0; } to { opacity: 1; } }
  /* Split-view flips snap instead of sliding. */
  .fl-split-rail, .fl-split-stage { transition: none; }
  .fl-stage { animation: none; }
  /* Silence every looping loader for vestibular-sensitive users. */
  .fl-caret, .fl-md--streaming > :last-child::after { animation: none; opacity: 1; }
  .fl-typing span, .fl-skeleton-bar,
  .fl-act-pulse, .fl-act-spin, .fl-connect-spin,
  .fl-auto-created-live::after { animation: none; }
  .fl-picker-item.is-just-connected, .fl-picker-item.is-just-connected .fl-picker-on { animation: none; }
  .fl-msglist-wrap, .fl-jump, .fl-md--streaming > * { animation: none; opacity: 1; }
  /* The launcher blob rests as a plain circle; the panel resize snaps. */
  .fl-launcher-blob { animation: none; border-radius: 50%; }
  .fl-overlay-panel { transition: none; }
}

/* ---------- full-screen mobile takeover (<768px, Intercom pattern) ---------- */
/* The \`fl-takeover\` class is stamped by useMobileTakeover (matchMedia) on the
   surface containers — the overlay panel (the Cmd+K overlay AND the slot's
   design overlay share OverlayPanel) and the page element. Full bleed, its own
   stacking context, internal scrolling (only .fl-msglist scrolls), the
   composer pinned at the bottom inside the safe area, the close X reachable
   under the notch. Host layout below the breakpoint is covered, not fixed. */
.fl-overlay-panel.fl-takeover { left: 0; top: 0; transform: none;
  width: 100%; height: 100%; max-width: none; max-height: none;
  border: 0; border-radius: 0; isolation: isolate;
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px)
    env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  /* --fl-kb-inset is stamped by useMobileTakeover from visualViewport: the
     bottom edge (the composer) lifts above the virtual keyboard. */
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--fl-kb-inset, 0px));
  /* The centered "squeeze" keyframes carry translate(-50%,-50%) — full bleed
     fades in instead of flying in from mid-screen. */
  animation: fl-takeover-fade .18s ease both; }
@keyframes fl-takeover-fade { from { opacity: 0; } to { opacity: 1; } }
.fl-overlay-panel.fl-takeover .fl-overlay-close {
  top: calc(12px + env(safe-area-inset-top, 0px));
  right: calc(12px + env(safe-area-inset-right, 0px)); }
.fl-overlay-panel.fl-takeover .fl-overlay-new {
  right: calc(46px + env(safe-area-inset-right, 0px)); }
/* Mobile mirror of compact-when-empty: the takeover starts as a bottom sheet
   (host page visible behind the scrim) and becomes the full-bleed takeover
   once a conversation is running. */
.fl-overlay-panel.fl-takeover:has(.fl-landing) { top: auto; bottom: 0; height: auto; max-height: 62%;
  border-top: 1px solid var(--vendo-border-strong);
  border-radius: var(--vendo-radius-lg) var(--vendo-radius-lg) 0 0; }
.fl-overlay-panel.fl-takeover:has(.fl-landing) .fl-landing { padding-top: 18px; }
.fl-page.fl-takeover { position: fixed; inset: 0; z-index: 2147483001; isolation: isolate;
  background: var(--vendo-bg);
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px)
    env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--fl-kb-inset, 0px)); }
/* The palette is a modal over EVERY takeover surface: its scrim (2147483000)
   would otherwise sit under a takeover page/overlay panel (2147483001). */
.fl-overlay-scrim.fl-takeover { z-index: 2147483002; }

/* ---------- mobile input + touch ergonomics (ENG-228) ---------- */
/* iOS Safari auto-zooms any focused text input under 16px, and 44px is the
   HIG touch-target floor. Keyed to small viewports OR coarse pointers so
   tablets in wide orientations still get honest targets; desktop keeps the
   quieter 15px/34px design. */
@media (max-width: 767px), (pointer: coarse) {
  .fl-composer textarea { font-size: 16px; }
  .fl-picker-search { font-size: 16px; }
  .fl-icon-btn { width: 44px; height: 44px; }
  .fl-jump { width: 44px; height: 44px; }
  .fl-overlay-close { width: 44px; height: 44px; }
  .fl-overlay-new { right: 62px; }
  .fl-overlay-expand { right: 112px; }
  .fl-invite-chip { width: 100%; min-height: 44px; justify-content: center; display: inline-flex; align-items: center; }
  .fl-invite-chips { align-self: stretch; align-items: stretch; max-width: none; padding: 0 8px; }
  /* The grown close button keeps its visual position under the notch. */
  .fl-overlay-panel.fl-takeover .fl-overlay-close {
    top: calc(4px + env(safe-area-inset-top, 0px));
    right: calc(4px + env(safe-area-inset-right, 0px)); }
  .fl-overlay-panel.fl-takeover .fl-overlay-new {
    right: calc(54px + env(safe-area-inset-right, 0px)); }
}


.fl-launcher { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--vendo-border);
  border-radius: 999px; padding: 10px 15px; font-size: 13px; font-weight: 600; color: var(--vendo-fg);
  background: var(--vendo-surface);
  box-shadow: var(--vendo-shadow-float); cursor: pointer; }
/* ENG-220: the supported overlay entry — VendoOverlay's default launcher is a
   fixed brand pill pinned to a viewport corner (safe-area aware). z-index sits
   one below the scrim so the open overlay covers it. Placement variants keyed
   off data-vendo-launcher so bare .fl-launcher keeps its in-flow behavior. */
.fl-launcher[data-vendo-launcher="bottom-right"], .fl-launcher[data-vendo-launcher="bottom-left"] {
  position: fixed; bottom: calc(20px + env(safe-area-inset-bottom, 0px)); z-index: 2147482999; }
.fl-launcher[data-vendo-launcher="bottom-right"] { right: calc(20px + env(safe-area-inset-right, 0px)); }
.fl-launcher[data-vendo-launcher="bottom-left"] { left: calc(20px + env(safe-area-inset-left, 0px)); }

/* The launcher mark (ui-lane-entry pick L-B): an accent-colored blob that
   continuously morphs shape — the recognition cue, in place of any glyph or
   product name. Quickens on hover; a static circle under reduced motion. */
.fl-launcher-blob { width: 20px; height: 20px; flex: none; background: var(--vendo-accent);
  animation: fl-blob-morph 7s ease-in-out infinite; }
.fl-launcher:hover .fl-launcher-blob { animation-duration: 2.4s; }
@keyframes fl-blob-morph {
  0%, 100% { border-radius: 58% 42% 55% 45% / 48% 55% 45% 52%; transform: rotate(0deg) scale(1); }
  25% { border-radius: 45% 55% 48% 52% / 58% 42% 58% 42%; transform: rotate(12deg) scale(1.05); }
  50% { border-radius: 52% 48% 42% 58% / 45% 52% 48% 55%; transform: rotate(-8deg) scale(.96); }
  75% { border-radius: 42% 58% 55% 45% / 52% 48% 55% 45%; transform: rotate(6deg) scale(1.03); } }
/* Blob-only orb: the host cleared the label (launcher.label: null). */
.fl-launcher[data-vendo-launcher-bare] { padding: 11px; gap: 0; border-radius: 50%; }

/* The whisper (ui-usage-dx §6): first eligible visit only — one gentle pulse
   on the pill plus a small ~6s caption. The pulse is motion-gated (reduced
   motion keeps the caption, drops the pulse); fire-once is enforced in JS. */
@media (prefers-reduced-motion: no-preference) {
  .fl-launcher[data-vendo-whisper] { animation: fl-whisper-pulse 1.8s ease-out .5s 1 both; }
  .fl-whisper { animation: fl-whisper-in .4s ease-out both; }
}
@keyframes fl-whisper-pulse {
  0% { box-shadow: var(--vendo-shadow-float), 0 0 0 0 color-mix(in srgb, var(--vendo-accent) 45%, transparent); }
  70% { box-shadow: var(--vendo-shadow-float), 0 0 0 14px color-mix(in srgb, var(--vendo-accent) 0%, transparent); }
  100% { box-shadow: var(--vendo-shadow-float), 0 0 0 0 transparent; }
}
@keyframes fl-whisper-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.fl-whisper { display: flex; flex-direction: column; gap: 3px; max-width: 250px; padding: 11px 14px;
  border: 1px solid var(--vendo-border); border-radius: 14px; background: var(--vendo-surface);
  box-shadow: var(--vendo-shadow-float); font-size: 12.5px; line-height: 1.45; }
.fl-whisper strong { font-weight: 600; font-size: 13px; color: var(--vendo-fg); }
.fl-whisper span { color: var(--vendo-fg-muted); }
/* Fixed variants sit just above the pill, matching its corner. */
.fl-whisper[data-vendo-launcher="bottom-right"], .fl-whisper[data-vendo-launcher="bottom-left"] {
  position: fixed; bottom: calc(72px + env(safe-area-inset-bottom, 0px)); z-index: 2147482999; }
.fl-whisper[data-vendo-launcher="bottom-right"] { right: calc(20px + env(safe-area-inset-right, 0px)); }
.fl-whisper[data-vendo-launcher="bottom-left"] { left: calc(20px + env(safe-area-inset-left, 0px)); }

/* ---------- page + tabs + slot ---------- */
/* The Page surface is ingrained: the chat IS the page (no card-in-card). Tabs are
   a quiet underline row, the body fills the height, only the message list scrolls. */
.fl-page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.fl-page > [hidden] { display: none; }
.fl-tabbar { display: flex; align-items: center; gap: 2px; padding: 0 0 0 2px;
  border-bottom: 1px solid var(--vendo-border); flex-shrink: 0; overflow-x: auto; scrollbar-width: none; }
.fl-tabbar::-webkit-scrollbar { display: none; }
.fl-tab { display: flex; align-items: center; gap: 7px; padding: 10px 13px; font-size: 12.5px; font-weight: 500;
  color: var(--vendo-fg-muted); border: 0; border-bottom: 2px solid transparent; background: transparent;
  cursor: pointer; white-space: nowrap; margin-bottom: -1px; transition: color .12s; }
.fl-tab:hover { color: var(--vendo-fg); }
.fl-tab[aria-selected="true"] { color: var(--vendo-fg); border-bottom-color: var(--vendo-accent); }
/* Body region below the tabs — the only thing that scrolls is the inner message list. */
.fl-page-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.fl-page-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.fl-page-pane[hidden] { display: none; }

/* ---------- generative dashboard slot (vendo-slot) ---------- */
.fl-slot { position: relative; width: 100%; min-height: var(--fl-slot-min-h, 370px);
  display: flex; flex-direction: column; }

/* ---- ghost (empty) state: faint skeleton behind a CTA ---- */
.fl-slot-ghost { position: relative; width: 100%; flex: 1; display: flex; flex-direction: column;
  cursor: pointer; overflow: hidden;
  border: 1px solid var(--vendo-border); border-radius: var(--vendo-radius); padding: 14px;
  background: var(--vendo-surface);
  color: var(--vendo-fg-muted); text-align: left; transition: border-color .14s, box-shadow .14s; }
.fl-slot-ghost:hover { border-color: var(--vendo-border-strong); box-shadow: var(--vendo-shadow-float); }
/* The empty-state ghost is a real button (ENG-223): strip the UA button chrome
   so it reads exactly like the div variant, and give the CTA a visible focus ring. */
.fl-slot-ghost-cta { font: inherit; appearance: none; -webkit-appearance: none; }
.fl-slot-ghost-cta:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 2px; }
.fl-slot-skel { flex: 1; display: flex; flex-direction: column; gap: 8px; min-height: 118px;
  opacity: .5; filter: blur(.3px); -webkit-mask-image: linear-gradient(180deg, #000 30%, transparent);
  mask-image: linear-gradient(180deg, #000 30%, transparent); }
.fl-skel-line { height: 9px; border-radius: 5px;
  background: color-mix(in srgb, var(--vendo-fg) 9%, transparent); }
.fl-skel-bars { display: flex; align-items: flex-end; gap: 6px; height: 52px; margin-top: auto; }
.fl-skel-bars span { flex: 1; border-radius: 3px;
  background: color-mix(in srgb, var(--vendo-fg) 12%, transparent); }
.fl-slot-cta { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 4px; font-size: 13px; font-weight: 600; color: var(--vendo-fg);
  background: color-mix(in srgb, var(--vendo-bg) 30%, transparent); transition: background .14s; }
.fl-slot-ghost:hover .fl-slot-cta { background: color-mix(in srgb, var(--vendo-bg) 16%, transparent); }
.fl-slot-cta svg { margin-bottom: 2px; opacity: .85; }
.fl-slot-cta small { font-weight: 400; font-size: 11.5px; color: var(--vendo-fg-muted); }

/* ---- empty-state invitation (ui-lane-entry pick S-A\u00d7S-D) ----
   Accent-washed surface carrying real copy, up to three concrete suggestion
   chips, and a primary CTA. The skeleton stays faintly behind (a view goes
   here); no icon by default. */
.fl-slot-invite { cursor: default;
  border-color: color-mix(in srgb, var(--vendo-accent) 22%, var(--vendo-border));
  background: linear-gradient(155deg, color-mix(in srgb, var(--vendo-accent) 7%, var(--vendo-surface)),
    color-mix(in srgb, var(--vendo-accent) 2%, var(--vendo-surface)) 55%); }
.fl-slot-invite:hover { border-color: color-mix(in srgb, var(--vendo-accent) 40%, var(--vendo-border)); }
.fl-slot-invite .fl-slot-skel { opacity: .35; }
.fl-slot-invite .fl-slot-cta { gap: 8px; background: none; cursor: default; }
.fl-invite-mark { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center;
  color: var(--vendo-fg); opacity: .85; }
.fl-invite-mark-tile { background: var(--vendo-accent); color: var(--vendo-accent-fg);
  opacity: 1; box-shadow: var(--vendo-shadow-float); }
.fl-invite-title { font: 600 14px/1 var(--vendo-font); color: var(--vendo-fg); }
.fl-invite-sub { font-weight: 400; font-size: 11.5px; color: var(--vendo-fg-muted); text-align: center;
  max-width: 82%; line-height: 1.4; }
.fl-invite-try { font: 600 10.5px/1 var(--vendo-font); letter-spacing: .05em; text-transform: uppercase;
  color: var(--vendo-fg-muted); margin-top: 2px; }
.fl-invite-chips { display: flex; flex-direction: column; gap: 7px; align-items: center; max-width: 92%; }
.fl-invite-chip { border: 1px solid var(--vendo-border); border-radius: 999px; padding: 8px 14px;
  background: var(--vendo-surface); font: 500 12px/1.2 var(--vendo-font); color: var(--vendo-fg);
  cursor: pointer; box-shadow: var(--vendo-shadow-float); transition: border-color .12s, transform .12s; }
.fl-invite-chip:hover { border-color: color-mix(in srgb, var(--vendo-accent) 40%, var(--vendo-border));
  transform: translateY(-1px); }
.fl-invite-chip:focus-visible, .fl-invite-btn:focus-visible, .fl-invite-own:focus-visible {
  outline: 2px solid var(--vendo-accent); outline-offset: 2px; }
.fl-invite-btn { margin-top: 6px; display: inline-flex; align-items: center; gap: 7px; border: 0;
  border-radius: 9px; padding: 9px 16px; background: var(--vendo-accent); color: var(--vendo-accent-fg);
  font: 600 12.5px/1 var(--vendo-font); cursor: pointer; box-shadow: var(--vendo-shadow-float);
  transition: opacity .14s, transform .14s; }
.fl-invite-btn:hover { opacity: .9; transform: translateY(-1px); }
.fl-invite-own { margin-top: 4px; border: 0; background: transparent; cursor: pointer;
  font: 500 11.5px/1 var(--vendo-font); color: var(--vendo-fg-muted);
  text-decoration: underline; text-underline-offset: 3px; }
.fl-invite-own:hover { color: var(--vendo-fg); }

/* ---- <Remixable>: the seed that blooms into the pill ----
   A ~9px muted ✦ at rest in the wrapped element's top-right corner, blooming
   IN PLACE into the ✦ Remix pill — same corner, same optical centre, so it
   reads as one mark opening rather than a glyph swapping for a button. The
   reveal is driven by [data-vendo-revealed] (React state), never :hover: a
   CSS-only reveal dies on the cursor's way to the pill, which is exactly the
   travel that has to keep it alive (Remixable holds it open for a grace
   period). A flat accent pill, never a ring — a projector loses an outline.
   Both marks sit above the host's own content but never intercept it: the
   seed is inert, the pill only once revealed. */
.fl-remixable { position: relative; }
.fl-remixable-chrome { display: contents; }
.fl-remix-seed { position: absolute; top: 4px; right: 5px; z-index: 6; pointer-events: none;
  font-size: 9px; line-height: 1; color: var(--vendo-accent); opacity: .32; }
.fl-remix-pill { position: absolute; top: 3px; right: 4px; z-index: 6; transform-origin: top right;
  display: inline-flex; align-items: center; gap: 5px; border: 0; border-radius: 3px;
  padding: 3px 8px; background: var(--vendo-accent); color: var(--vendo-accent-fg);
  font: 600 11px/1.35 var(--vendo-font-family); letter-spacing: .01em; white-space: nowrap;
  cursor: pointer; opacity: 0; transform: scale(.9); pointer-events: none; }
.fl-remix-pill-mark { font-size: 10px; line-height: 1; }
.fl-remixable[data-vendo-revealed] .fl-remix-seed { opacity: 0; transform: scale(1.4); }
.fl-remixable[data-vendo-revealed] .fl-remix-pill { opacity: 1; transform: scale(1); pointer-events: auto; }
.fl-remixable[data-vendo-revealed] .fl-remix-pill:active { transform: scale(.97); }
.fl-remix-pill:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 2px; }
/* The bloom itself — guarded, so under reduced motion the two states simply
   swap with no travel (the .vendo-root[data-vendo-motion="reduced"] rule
   covers the theme-level dial the same way). */
@media (prefers-reduced-motion: no-preference) {
  .fl-remix-seed { transition: opacity 120ms cubic-bezier(.23,1,.32,1), transform 120ms cubic-bezier(.23,1,.32,1); }
  .fl-remix-pill { transition: opacity 180ms cubic-bezier(.23,1,.32,1), transform 180ms cubic-bezier(.23,1,.32,1); }
}

/* ---- ✦ management popover (2026-08-02 final shape) ----
   The pill on an already-remixed component opens this instead of forking:
   status line, open-in-panel, revert. Borrows the slot menu's glass look.
   The wrap carries the pill's absolute position so pill and menu share an
   anchor; the pill inside it drops its own offset. No entry animation — the
   popover appears in place (reduced motion needs no special case). */
.fl-remix-menu-wrap { position: absolute; top: 3px; right: 4px; z-index: 7; }
.fl-remix-menu-wrap .fl-remix-pill { position: static; }
.fl-remix-menu { position: absolute; top: 26px; right: 0; min-width: 188px; padding: 6px;
  display: flex; flex-direction: column; gap: 2px; text-align: left;
  border: 1px solid var(--vendo-border-strong); border-radius: 12px;
  background: var(--vendo-surface);
  box-shadow: var(--vendo-shadow-float); font-family: var(--vendo-font-family); }
.fl-remix-status { padding: 6px 9px 7px; font: 500 11px/1.4 var(--vendo-font-family);
  color: var(--vendo-fg-muted); border-bottom: 1px solid var(--vendo-border); margin-bottom: 3px; }
.fl-remix-menu button { text-align: left; font: 500 12.5px/1.2 var(--vendo-font-family); padding: 7px 9px;
  border: 0; border-radius: 8px; background: transparent; color: var(--vendo-fg); cursor: pointer; }
.fl-remix-menu button:hover { background: var(--vendo-accent-soft); }
.fl-remix-menu button:disabled { color: var(--vendo-fg-muted); cursor: default; }
.fl-remix-menu button.is-danger { color: var(--vendo-danger); }

/* ---- filled state ---- */
.fl-slot-filled { position: relative; flex: 1; }

/* ---------- error ---------- */
.fl-error { margin: 8px 16px; padding: 10px 13px; border-radius: 12px;
  border: 1px solid var(--vendo-danger-border); background: var(--vendo-danger-bg);
  color: var(--vendo-danger); font-size: 12.5px;
  display: flex; align-items: center; gap: 10px; }
.fl-error-detail { display: block; margin-top: 3px; font-size: 12px; opacity: 0.85; overflow-wrap: anywhere; }
.fl-error-retry { margin-left: auto; flex-shrink: 0; padding: 4px 11px; border-radius: 8px;
  border: 1px solid var(--vendo-danger-border); background: transparent;
  color: var(--vendo-danger); font: 600 12px/1.2 var(--vendo-font); cursor: pointer; }
/* Hover fill: page-bg text reads on the danger fill in light; on a dark theme
   the page bg is near-black on red, so the dark branch pins white (ENG-226). */
.fl-error-retry:hover { background: var(--vendo-danger); color: light-dark(var(--vendo-bg, #fff), #fff); }

/* ---------- VendoToasts (2026-07-04): automation delivery surface ---------- */
.fl-toasts { position: fixed; z-index: 2147483100; display: flex; flex-direction: column; gap: 10px;
  width: min(340px, calc(100vw - 32px)); font-family: var(--vendo-font); }
.fl-toasts[data-placement="bottom-right"] { right: 18px; bottom: 18px; }
.fl-toasts[data-placement="bottom-left"] { left: 18px; bottom: 18px; }
.fl-toasts[data-placement="top-right"] { right: 18px; top: 18px; }
.fl-toasts-card { display: flex; gap: 9px; align-items: flex-start; padding: 11px 13px;
  border-radius: 13px; border: 1px solid var(--vendo-border); background: var(--vendo-surface);
  color: var(--vendo-fg); box-shadow: 0 10px 30px rgba(0,0,0,.16);
  animation: fl-toast-in .18s ease-out; }
.fl-toasts-card[data-kind="approval-required"] { border-color: var(--vendo-warn-border); }
.fl-toasts-card[data-state="error"] { border-color: var(--vendo-danger-border); }
.fl-toasts-icon { color: var(--vendo-accent); font-size: 13px; line-height: 1.5; }
.fl-toasts-card[data-kind="approval-required"] .fl-toasts-icon { color: var(--vendo-warn); }
.fl-toasts-body { display: flex; flex-direction: column; gap: 7px; min-width: 0; flex: 1; }
.fl-toasts-text { font-size: 12.5px; line-height: 1.45; }
.fl-toasts-actions { display: flex; align-items: center; gap: 10px; }
.fl-toasts-approve { border: 0; border-radius: 8px; padding: 5px 12px; cursor: pointer;
  background: var(--vendo-accent); color: var(--vendo-accent-fg);
  font: 600 12px/1.2 var(--vendo-font); }
.fl-toasts-approve:hover { opacity: .88; }
.fl-toasts-view { border: 0; background: none; padding: 0; cursor: pointer;
  color: var(--vendo-accent); font: 600 12px/1.2 var(--vendo-font); }
.fl-toasts-view:hover { text-decoration: underline; }
.fl-toasts-hint { font-size: 11.5px; color: var(--vendo-fg-muted); }
.fl-toasts-dismiss { margin-left: auto; border: 0; background: none; padding: 0 2px; cursor: pointer;
  color: var(--vendo-fg-muted); font: 600 12px/1 var(--vendo-font); }
.fl-toasts-dismiss:hover { color: var(--vendo-fg); }
@keyframes fl-toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
/* ---------- realtime voice stage (ENG-185) ---------- */
/* The stage fills the surface that launched it. The blob head is pinned; the
   feed scrolls beneath it; the caption + footer stay anchored at the bottom.
   overflow hidden: when the stage shares a bounded flex column with a thread
   (Maple /vendo stacks them as siblings) a short viewport squeezes this root
   toward zero height — without the clip its foot (the Transcript button) kept
   painting over the thread content above and STOLE ITS CLICKS (the in-thread
   Approve button's lower half landed on Transcript at ~729px-tall viewports).
   A squeezed stage must clip to its own box, never overlay a sibling. */
.fl-voice-root { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }
.fl-voice-root > .fl-voice-stage { flex: 1; }
.fl-voice-stage { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0;
  animation: fl-voice-rise .42s cubic-bezier(.22, 1, .36, 1) both; }
@keyframes fl-voice-rise { from { opacity: 0; transform: translateY(18px) scale(.985); }
  to { opacity: 1; transform: none; } }
.fl-voice-stage.is-leaving { animation: fl-voice-settle .5s ease both; }
@keyframes fl-voice-settle { from { opacity: 1; transform: none; }
  to { opacity: 0; transform: translateY(14px) scale(.99); } }

/* Presence rests centered until the first view lands, then rises to the top.
   Grid rows [lift · head · feed]: the lift spacer animates 1fr → 0fr, carrying
   the head from vertical center up to the top as the feed opens beneath it. */
.fl-voice-canvas { flex: 1; min-height: 0; display: grid;
  grid-template-rows: 1fr auto 1fr;
  transition: grid-template-rows .55s cubic-bezier(.22, 1, .36, 1); }
.fl-voice-canvas.has-views { grid-template-rows: 0fr auto 1fr; }
.fl-voice-lift { min-height: 0; }
.fl-voice-head { display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 18px 0 10px; flex-shrink: 0; }
.fl-voice-blob { position: relative; display: grid; place-items: center; border-radius: 50%;
  color: var(--vendo-accent); transition: transform .12s ease; }
.fl-voice-blob .fl-voice-disc { width: 46%; height: 46%; border-radius: 50%;
  background: var(--vendo-accent); transition: background .2s, opacity .2s; }
.fl-voice-blob.is-muted .fl-voice-disc, .fl-voice-blob.is-error .fl-voice-disc { opacity: .38; }
.fl-voice-blob.is-error .fl-voice-disc { background: var(--vendo-fg-muted); }
.fl-voice-glyph { position: absolute; display: grid; place-items: center; color: var(--vendo-fg);
  opacity: .85; }
.fl-voice-status { font: 500 12px/1 var(--vendo-font); color: var(--vendo-fg-muted);
  letter-spacing: .01em; min-height: 12px; }
.fl-voice-stage.is-speaking .fl-voice-status { color: var(--vendo-fg); }

/* The scroll edges blur out: content dissolves under the blob and above the
   caption. A soft alpha mask on the scroller + frosted strips (backdrop blur,
   themselves mask-faded so the blur tapers instead of ending on a hard line). */
.fl-voice-feedwrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.fl-voice-feedwrap::before, .fl-voice-feedwrap::after { content: ""; position: absolute; left: 0; right: 0;
  height: 40px; z-index: 1; pointer-events: none; }
.fl-voice-feedwrap::before { top: 0;
  -webkit-mask-image: linear-gradient(180deg, #000 30%, transparent);
  mask-image: linear-gradient(180deg, #000 30%, transparent); }
.fl-voice-feedwrap::after { bottom: 0;
  -webkit-mask-image: linear-gradient(0deg, #000 30%, transparent);
  mask-image: linear-gradient(0deg, #000 30%, transparent); }
/* An ACTUAL stage: each view is a full slide; scroll pages between slides
   (mandatory snap — one view owns the stage at rest, always). */
.fl-voice-feed { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain;
  scroll-snap-type: y mandatory;
  display: flex; flex-direction: column; padding: 0 18px; scrollbar-width: none;
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 24px, #000 calc(100% - 22px), transparent);
  mask-image: linear-gradient(180deg, transparent 0, #000 24px, #000 calc(100% - 22px), transparent); }
.fl-voice-feed::-webkit-scrollbar { display: none; }
/* Slides are slightly shorter than the stage and snap to CENTER, so the
   neighbors peek in at the top/bottom edges — blurred, smaller, unmistakably
   "there's more" — and grow into the frame as they take focus. A too-tall
   view scrolls inside its card instead of hanging below the fold. */
.fl-voice-slide { height: calc(100% - 84px); box-sizing: border-box; flex-shrink: 0;
  scroll-snap-align: center; scroll-snap-stop: always;
  display: flex; align-items: center; justify-content: center; padding: 4px 0;
  /* Off-stage: blurred, dimmed, visibly smaller; the focused one is crisp
     and whole. The transition IS the "animate into the frame" beat. */
  filter: blur(2.5px); opacity: .45; transform: scale(.78);
  transition: filter .45s ease, opacity .45s ease, transform .45s ease; }
.fl-voice-slide.is-focus { filter: none; opacity: 1; transform: none; }
/* Neighbors hug the boundary nearest the stage, so what peeks is the CARD's
   edge, not empty slide padding. */
.fl-voice-slide.is-before { align-items: flex-end; }
.fl-voice-slide.is-after { align-items: flex-start; }
/* Edge spacers give the deck's first/last slide the scroll room to reach
   true center — without them the ends rest half-a-peek off-center. */
.fl-voice-feed::before, .fl-voice-feed::after { content: ""; flex: 0 0 42px; }
@media (prefers-reduced-motion: no-preference) {
  /* \`backwards\`, never \`both\`: a forwards fill would pin the keyframe's
     \`transform: none; opacity: 1\` over the off-stage shrink/dim forever. */
  .fl-voice-slide { animation: fl-item-in .36s cubic-bezier(.22, 1, .36, 1) backwards; }
}
/* Tall views scroll inside their slide — mandatory snap never traps content.
   No border-radius here: the card has no background of its own, so a radius
   would only clip the flush top corners of the sandboxed view (the generated
   title/table headers sit at the iframe's edge — margin:0 body). The rounding
   belongs to the view's own surfaces, and to the pending card below. */
.fl-voice-slide .fl-voice-card { width: min(720px, 100%); max-height: 100%; overflow: auto;
  scrollbar-width: none; }
.fl-voice-slide .fl-voice-card::-webkit-scrollbar { display: none; }
.fl-voice-slide.is-pending .fl-voice-card { border: 1px solid var(--vendo-border); padding: 12px;
  border-radius: var(--vendo-radius); background: var(--vendo-surface); }
/* Slide dots — where you are among the session's views; tap to jump. */
.fl-voice-dots { position: absolute; right: 7px; top: 50%; transform: translateY(-50%); z-index: 2;
  display: flex; flex-direction: column; gap: 8px; }
.fl-voice-dots button { width: 7px; height: 7px; border-radius: 50%; border: 0; padding: 0;
  cursor: pointer; background: color-mix(in srgb, var(--vendo-fg) 22%, transparent);
  transition: background .2s ease, transform .2s ease; }
.fl-voice-dots button.is-on { background: var(--vendo-accent); transform: scale(1.3); }

/* Lives in the head, right under the blob + status — the words stay with the
   presence. Fixed height (~2 lines) so the feed doesn't jump as lines stream. */
/* Two sticky rows — your last line and the agent's — each clamped so long
   streaming lines show their tail, not their start. Settled lines dim
   instead of vanishing. */
.fl-voice-caption { height: 62px; padding: 0 22px; text-align: center; max-width: 620px;
  font-size: 13.5px; line-height: 1.45; flex-shrink: 0; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 2px; }
.fl-voice-caption > span { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
.fl-voice-caption .is-user { color: var(--vendo-fg-muted); font-size: 12.5px; -webkit-line-clamp: 1; }
.fl-voice-caption .is-user::before { content: "“"; }
.fl-voice-caption .is-user::after { content: "”"; }
.fl-voice-caption .is-agent { color: var(--vendo-fg); -webkit-line-clamp: 2; }
.fl-voice-caption .is-settled { opacity: .55; transition: opacity .4s ease; }
.fl-voice-caption em { font-style: italic; color: var(--vendo-fg-muted); }

/* ---- consent bar: approvals dock at the edge, the agent's UI keeps the
   stage. Act tier breathes the listening ring (spoken yes acceptable);
   critical goes amber with the named confirm; settled = transient receipt. */
.fl-voice-consent { margin: 0 18px 8px; padding: 9px 12px; border-radius: 13px; flex-shrink: 0;
  display: flex; align-items: center; gap: 10px; font-size: 12.5px;
  border: 1px solid var(--vendo-border-strong); background: var(--vendo-surface);
  box-shadow: var(--vendo-shadow-float); animation: fl-item-in .3s cubic-bezier(.22, 1, .36, 1) both; }
.fl-voice-consent.is-listening { animation: fl-item-in .3s cubic-bezier(.22, 1, .36, 1) both,
  fl-voice-ring 2.2s ease-in-out .3s infinite; }
.fl-voice-consent-fact { font-weight: 400; color: var(--vendo-fg-muted); }
.fl-voice-consent-warn { font-size: 11px; font-weight: 500; color: var(--vendo-warn-text); }
.fl-voice-consent.is-critical { border-color: color-mix(in srgb, var(--vendo-warn-edge) 55%, var(--vendo-border)); }
.fl-voice-consent.is-receipt { justify-content: center; font-weight: 600; color: var(--vendo-ok);
  border-color: color-mix(in srgb, var(--vendo-ok) 40%, var(--vendo-border)); }
.fl-voice-consent.is-receipt.is-declined { color: var(--vendo-fg-muted);
  border-color: var(--vendo-border); }

.fl-voice-banner { margin: 0 18px 8px; padding: 9px 13px; border-radius: 12px; flex-shrink: 0;
  border: 1px solid var(--vendo-danger-border); background: var(--vendo-danger-bg);
  color: var(--vendo-danger); font-size: 12.5px; display: flex; align-items: center; gap: 10px; }
.fl-voice-stage.is-reconnecting .fl-voice-banner { border-color: var(--vendo-border-strong);
  background: var(--vendo-surface); color: var(--vendo-fg-muted); }

.fl-voice-foot { display: flex; align-items: center; justify-content: space-between;
  padding: 6px 14px 12px; flex-shrink: 0; }
.fl-voice-drawer-btn { border: 0; background: transparent; color: var(--vendo-fg-muted);
  font: 500 11.5px/1 var(--vendo-font); letter-spacing: .02em; cursor: pointer; padding: 6px 4px; }
.fl-voice-drawer-btn:hover { color: var(--vendo-fg); }
.fl-voice-controls { display: flex; align-items: center; gap: 6px; }
.fl-voice-controls .fl-icon-btn.is-active { color: var(--vendo-danger); }

.fl-voice-drawer { position: absolute; left: 10px; right: 10px; bottom: 46px; max-height: 46%;
  overflow: auto; z-index: 4; padding: 12px 14px; border-radius: 14px;
  border: 1px solid var(--vendo-border-strong); background: var(--vendo-surface);
  box-shadow: var(--vendo-shadow-float); display: flex; flex-direction: column; gap: 8px;
  animation: fl-fade-in .16s ease; }
.fl-voice-drawer-empty { font-size: 12px; color: var(--vendo-fg-muted); text-align: center; padding: 8px; }
.fl-voice-line { display: grid; grid-template-columns: 44px 1fr; gap: 10px; font-size: 12.5px; line-height: 1.45; }
.fl-voice-line-role { color: var(--vendo-fg-muted); font-weight: 600; font-size: 11px; padding-top: 1px; }
.fl-voice-line.is-user span:last-child { color: var(--vendo-fg-muted); }
.fl-voice-line.is-agent span:last-child { color: var(--vendo-fg); }
.fl-voice-line em { font-style: italic; color: var(--vendo-fg-muted); }

/* ---- approval card voice/tier registers (ENG-185 × ENG-193) ---- */
/* Act-tier while a spoken yes is acceptable: a soft breathing ring. */
.fl-approval-listening { animation: fl-voice-ring 2.2s ease-in-out infinite; }
@keyframes fl-voice-ring {
  0%, 100% { box-shadow: 0 0 0 1px color-mix(in srgb, var(--vendo-accent) 34%, transparent); }
  50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--vendo-accent) 12%, transparent); } }
/* Critical: amber always-confirm register — voice announces, the hand confirms. */
/* Settled: the card becomes a receipt. */
.fl-approval-approved { border-color: color-mix(in srgb, var(--vendo-ok) 45%, var(--vendo-border)); }

@media (prefers-reduced-motion: reduce) {
  .fl-voice-stage, .fl-voice-stage.is-leaving, .fl-voice-slide { animation: none; opacity: 1; }
  .fl-voice-canvas { transition: none; }
  .fl-voice-slide:not(.is-focus) { opacity: .45; }
  .fl-voice-blob { transition: none; transform: none !important; }
  .fl-approval-listening { animation: none;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--vendo-accent) 30%, transparent); }
  .fl-voice-consent, .fl-voice-consent.is-listening { animation: none;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--vendo-accent) 30%, transparent); }
  /* No animated blur for vestibular-sensitive users: unfocused slides dim only. */
  .fl-voice-slide { transition: none; filter: none; }
  .fl-voice-dots button { transition: none; }
}

.fl-voice-consent.is-automation { display: block; padding: 0; background: none; border: none; box-shadow: none; }
.fl-voice-consent.is-automation .fl-approval { width: 100%; max-width: none; }

/* --- a11y hardening (design port): guaranteed focus ring + AA ceremony buttons --- */
.vendo-root :focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 2px; }
/* Chromium applies :focus-visible to text inputs on ANY focus (including
   clicks), so the global keyboard ring would draw a hard rectangle inside the
   composer on every click. The composer container carries its own focus
   treatment (.fl-composer:has(:focus-visible)); the inner textarea stays bare. */
.vendo-root .fl-composer textarea:focus-visible { outline: none; }
/* Amber ceremony/critical confirm buttons stay AA 4.5:1 in BOTH schemes: dark
   amber fill + white text in light (7.1:1); light amber fill + near-black text
   in dark (8.7:1, and the fill itself pops ~8:1 off the dark warn-bg) — flipping only the fill
   would drop white-on-#d9a94e to 2.2:1 (ENG-226 review catch). */
.fl-btn-ceremony { background: var(--vendo-warn); border-color: transparent;
  color: var(--vendo-warn-on-fill); }
.fl-btn-ceremony:hover { opacity: .92; background: var(--vendo-warn); }

/* ==================== ui-lane-panels lane block ====================
   Converged picks (the lane report they came from was worktree scratch, never
   part of the repo — the picks themselves are recorded here):
   activity B (icon ledger) · vendo-activities B (approval queue pager) ·
   automations B (run-dot strip) · connected-accounts A+D+F (identity rows,
   two-step disconnect + undo, connect-ahead empty state).
   Every value derives from the existing --vendo-* tokens. */

/* ---- activity icon ledger (shared by ActivityPanel + VendoActivities) ---- */
.fl-act-led { list-style: none; margin: 0; padding: 0; }
.fl-act-led-row { display: grid; grid-template-columns: 26px minmax(0, 1.9fr) 1fr auto; gap: 10px;
  align-items: center; padding: 8px 13px; border-bottom: 1px solid var(--vendo-border); }
.fl-act-led-row:last-child { border-bottom: 0; }
.fl-act-led-row:hover { background: var(--vendo-accent-soft); }
.fl-act-led-ic { width: 24px; height: 24px; border-radius: 8px; display: grid; place-items: center;
  background: var(--vendo-accent-soft); border: 1px solid var(--vendo-border); color: var(--vendo-fg);
  flex-shrink: 0; }
.fl-act-led-ic svg { width: 13px; height: 13px; }
.fl-act-led-main { min-width: 0; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.fl-act-led-main b { font-weight: 550; }
.fl-act-led-det { color: var(--vendo-fg-muted); font-size: 11.5px; }
.fl-act-led-out { min-width: 0; }
.fl-act-led-by { color: var(--vendo-fg-muted); font-size: 10.5px; }
/* Narrow viewports (375px hosts): result wraps under the action so the
   outcome and timestamp never collide. */
@media (max-width: 480px) {
  .fl-act-led-row { grid-template-columns: 26px minmax(0, 1fr) auto;
    grid-template-areas: "ic main when" "ic out out"; row-gap: 3px; }
  .fl-act-led-ic { grid-area: ic; }
  .fl-act-led-main { grid-area: main; }
  .fl-act-led-out { grid-area: out; }
  .fl-act-led-row > .fl-act-when { grid-area: when; }
}

/* ---- vendo-activities approval queue pager ---- */
.fl-approvals-pager { display: flex; align-items: center; gap: 8px; }
.fl-approvals-dots { display: flex; gap: 4px; margin-left: auto; }
.fl-approvals-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--vendo-border-strong); }
.fl-approvals-dot--on { background: var(--vendo-accent); }
.fl-approvals-stack { position: relative; }
.fl-approvals-stack .fl-approval { width: 100%; max-width: 100%; }
.fl-approvals-slide { animation: fl-approval-enter .32s var(--vendo-motion-easing) both; }
@keyframes fl-approval-enter { from { opacity: 0; transform: translateX(14px) scale(.985); } }
.fl-approvals-ghost { position: absolute; inset: 6px -5px auto auto; width: 96%; height: 100%;
  border: 1px solid var(--vendo-border); border-radius: var(--vendo-radius);
  background: var(--vendo-surface); z-index: -1; }

/* ---- automations run-dot history strip ---- */
.fl-auto-runs { display: flex; align-items: center; gap: 4px; padding: 12px 16px 14px;
  border-top: 1px solid var(--vendo-border); }
.fl-auto-runs-lbl { font-size: 11px; color: var(--vendo-fg-muted); margin-right: 6px; white-space: nowrap; }
.fl-auto-runs-dot { width: 14px; height: 7px; border-radius: 3px; background: var(--vendo-ok);
  opacity: .85; animation: fl-auto-runs-pop .3s var(--vendo-motion-easing) both; cursor: default; }
.fl-auto-runs-dot[data-status="error"] { background: var(--vendo-danger); }
.fl-auto-runs-dot[data-status="stopped"] { background: var(--vendo-border-strong); }
.fl-auto-runs-dot[data-status="running"] { background: var(--vendo-accent); }
.fl-auto-runs-dot:hover { transform: scaleY(1.4); }
@keyframes fl-auto-runs-pop { from { opacity: 0; transform: scaleY(.2); } }
.fl-auto-runs-sum { margin-left: auto; font-size: 11px; color: var(--vendo-fg-muted);
  white-space: nowrap; }

/* ---- connected accounts: identity rows + disconnect ceremony + empty ---- */
.fl-acct-logo { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center;
  background: var(--vendo-surface); border: 1px solid var(--vendo-border); flex-shrink: 0;
  box-shadow: inset 0 1px 0 light-dark(rgba(255,255,255,.58), rgba(255,255,255,.08)); }
.fl-acct-title { display: flex; align-items: center; gap: 8px; }
.fl-acct-chip { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px;
  padding: 3px 9px; font: 600 10.5px/1.2 var(--vendo-font); }
.fl-acct-chip i { width: 5px; height: 5px; border-radius: 999px; background: currentColor; }
.fl-acct-chip--ok { color: var(--vendo-ok); background: color-mix(in srgb, var(--vendo-ok) 11%, transparent); }
.fl-acct-chip--warn { color: var(--vendo-warn-text); background: color-mix(in srgb, var(--vendo-warn-tint) 14%, transparent); }
.fl-acct-chip--danger { color: var(--vendo-danger); background: color-mix(in srgb, var(--vendo-danger) 11%, transparent); }
.fl-acct-chip--off { color: var(--vendo-fg-muted); background: color-mix(in srgb, var(--vendo-fg) 7%, transparent); }
.fl-acct-actions { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.fl-acct-actions .fl-btn { display: inline-flex; align-items: center; gap: 6px; }
.fl-acct-confirm { overflow: hidden; max-height: 0; transition: max-height .3s var(--vendo-motion-easing); }
.fl-acct-confirm--open { max-height: 150px; }
.fl-acct-confirm-inner { border-top: 1px solid var(--vendo-warn-border); background: var(--vendo-warn-bg);
  padding: 11px 16px; font-size: 12px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.fl-acct-confirm-inner b { font-weight: 600; }
.fl-acct-confirm-sub { display: block; color: var(--vendo-fg-muted); font-size: 11.5px; margin-top: 2px; }
.fl-acct-confirm-actions { margin-left: auto; display: flex; gap: 6px; flex-shrink: 0; }
.fl-acct-confirm-actions .fl-btn { padding: 5px 12px; font-size: 11.5px; }
.fl-acct-severed { display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  border: 1px solid var(--vendo-border); border-radius: var(--vendo-radius);
  background: color-mix(in srgb, var(--vendo-fg) 3%, transparent); font-size: 12.5px;
  color: var(--vendo-fg-muted); animation: fl-item-in .3s ease-out both; }
.fl-acct-undo { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; }
.fl-acct-undo .fl-btn { padding: 5px 12px; font-size: 11.5px; }
.fl-acct-undo-count { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--vendo-fg-muted); }
.fl-acct-ghost { border: 1.5px dashed var(--vendo-border-strong); border-radius: var(--vendo-radius);
  padding: 18px; display: flex; flex-direction: column; gap: 10px; }
.fl-acct-ghost-title { font-weight: 600; font-size: 13.5px; }
.fl-acct-ghost-copy { margin: 0; color: var(--vendo-fg-muted); font-size: 12.5px; line-height: 1.55; }
.fl-acct-connect-row { display: flex; flex-wrap: wrap; gap: 8px; }
.fl-acct-connect-chip { display: inline-flex; align-items: center; gap: 8px;
  border: 1.5px dashed var(--vendo-border-strong); border-radius: 999px; background: transparent;
  color: var(--vendo-fg); padding: 6px 13px 6px 7px; font: 600 12px/1.2 var(--vendo-font); cursor: pointer; }
.fl-acct-connect-chip:hover { background: var(--vendo-accent-soft); border-style: solid; }
.fl-acct-connect-chip:disabled { opacity: .6; cursor: default; }
.fl-acct-connect-chip .fl-acct-logo { width: 24px; height: 24px; border-radius: 999px; }

/* ---- wave-3 share dialog + fork offer (build contract §9.2-§9.6) ---- */
.fl-share { display: flex; flex-direction: column; gap: 12px; padding: 16px;
  border: 1px solid var(--vendo-border); border-radius: var(--vendo-radius);
  background: var(--vendo-surface); font: 400 13px/1.5 var(--vendo-font); color: var(--vendo-fg); }
.fl-share-head { display: flex; align-items: center; gap: 10px; }
.fl-share-title { font-weight: 600; font-size: 14px; }
.fl-share-head .fl-btn { margin-left: auto; }
.fl-share-note { margin: 0; color: var(--vendo-fg-muted); font-size: 12.5px; }
.fl-share-add { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.fl-share-input { flex: 1 1 180px; min-width: 0; padding: 7px 11px; font: inherit;
  border: 1px solid var(--vendo-border); border-radius: 9px; background: var(--vendo-bg); color: inherit; }
.fl-share-level { padding: 7px 9px; font: inherit; border: 1px solid var(--vendo-border);
  border-radius: 9px; background: var(--vendo-bg); color: inherit; }
/* One labelled control that appears mid-task (who exactly, which team). Tighter
   than the dialog's own 12px gap, so the label belongs to ITS field rather than
   floating between two. The basis reset is load-bearing: .fl-share-input carries
   flex-basis 180px for the horizontal row, which in a column would be a height. */
.fl-share-field { display: flex; flex-direction: column; gap: 6px; }
.fl-share-field .fl-share-input { flex: 0 0 auto; }
.fl-share-error { margin: 0; color: var(--vendo-danger); font-size: 12.5px; }
.fl-share-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.fl-share-empty { color: var(--vendo-fg-muted); font-size: 12.5px; padding: 6px 0; }
.fl-share-row { display: flex; align-items: center; gap: 10px; padding: 8px 0;
  border-top: 1px solid var(--vendo-border); }
.fl-share-who { font-weight: 500; }
.fl-share-lvl { color: var(--vendo-fg-muted); font-size: 12px; }
.fl-share-revoke { margin-left: auto; }
.fl-share-fork { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px;
  border: 1px solid var(--vendo-border); border-radius: var(--vendo-radius);
  background: var(--vendo-accent-soft); font: 400 13px/1.55 var(--vendo-font); color: var(--vendo-fg); }
.fl-share-fork-copy { margin: 0; }
.fl-share-fork-actions { display: flex; gap: 8px; flex-wrap: wrap; }

/* ================== end ui-lane-panels lane block ================== */

/* ================================================================
   voice-lane composite (2026-07-19) — ui-lane-voice's converged Round 2:
   PiP dock (P-C) · speaker lean (P-F) · rolling ticker (S-C) · idle
   invitation (S-E) · attention vignette (S-F) · spoken-yes consent (C-A) ·
   connect-during-voice slot (Cn-A) · mobile safe-area foot (M-A).
   One marked block so every lane's chrome-css edits merge cleanly.
   ================================================================ */

/* ---- S-C rolling ticker: the caption slot holds the last 3 transcript
   lines, newest bright, older fading and shrinking upward. */
.fl-voice-caption { height: 84px; }
.fl-voice-tick { animation: fl-voice-tick-up .4s cubic-bezier(.22, 1, .36, 1) both; }
.fl-voice-tick.is-age-2 { opacity: .3; font-size: 11.5px; }
.fl-voice-tick.is-age-1 { opacity: .55; font-size: 12.5px; }
.fl-voice-tick.is-age-0 { opacity: 1; }
.fl-voice-tick.is-age-0.is-settled { opacity: .8; }
@keyframes fl-voice-tick-up { from { transform: translateY(9px); opacity: 0; } }

/* ---- P-C dock: once a view lands the head becomes a corner pill (travel is
   FLIP-animated in stage.tsx on fluidkit MorphSurface's BODY_SPRING; the ball
   remounts at 30px — never a scaled svg). The pill and the docked ticker own
   an aligned top band; the deck starts below it. */
.fl-voice-stage.is-docked .fl-voice-canvas { grid-template-rows: 0fr auto 1fr; }
.fl-voice-stage.is-docked .fl-voice-head { position: absolute; top: 12px; right: 14px; z-index: 5;
  flex-direction: row; align-items: center; gap: 8px; min-height: 52px;
  padding: 5px 12px 5px 6px; border-radius: 999px;
  border: 1px solid var(--vendo-border-strong); background: var(--vendo-surface);
  box-shadow: var(--vendo-shadow-float); }
.fl-voice-stage.is-docked .fl-voice-status { min-height: auto; }
.fl-voice-stage.is-docked > .fl-voice-caption { position: absolute; top: 12px; left: 14px; z-index: 5;
  height: auto; min-height: 52px; max-width: min(46%, 360px); padding: 8px 12px;
  text-align: left; align-items: flex-start; justify-content: center;
  border-radius: 12px; border: 1px solid var(--vendo-border); background: var(--vendo-surface);
  animation: fl-item-in .3s cubic-bezier(.22, 1, .36, 1) both; }
.fl-voice-stage.is-docked > .fl-voice-caption .fl-voice-tick.is-age-2 { display: none; }
.fl-voice-stage.is-docked .fl-voice-feedwrap { margin-top: 80px; }

/* ---- P-F speaker lean: the presence settles toward the user's words and
   lifts for its own — center-stage only; the docked pill stays still. */
.fl-voice-stage:not(.is-docked) .fl-voice-blob { transition: transform .6s cubic-bezier(.22, 1, .36, 1), filter .6s ease; }
.fl-voice-stage:not(.is-docked) .fl-voice-blob.is-lean-user { transform: translateY(7px) scale(.97); }
.fl-voice-stage:not(.is-docked) .fl-voice-blob.is-lean-agent { transform: translateY(-5px) scale(1.04); filter: brightness(1.06); }
.fl-voice-glow { width: 120px; height: 26px; margin-top: -20px; border-radius: 50%; flex-shrink: 0;
  background: radial-gradient(ellipse, color-mix(in srgb, var(--vendo-accent) 22%, transparent), transparent 70%);
  filter: blur(6px); pointer-events: none; animation: fl-fade-in .6s ease both; }

/* ---- S-E idle invitation: host-provided suggestion chips under the presence. */
.fl-voice-invite { display: flex; flex-direction: column; gap: 8px; align-items: center; margin-top: 6px; }
.fl-voice-chip { border: 1px solid var(--vendo-border-strong); border-radius: 999px; cursor: pointer;
  background: var(--vendo-surface);
  color: var(--vendo-fg); font: 500 12.5px/1 var(--vendo-font); padding: 10px 16px;
  animation: fl-item-in .4s cubic-bezier(.22, 1, .36, 1) backwards;
  transition: border-color .15s, transform .15s; }
.fl-voice-chip:hover { border-color: var(--vendo-accent); transform: translateY(-1px); }
.fl-voice-chip:nth-child(2) { animation-delay: .08s; }
.fl-voice-chip:nth-child(3) { animation-delay: .16s; }
.fl-voice-invite-hint { font: 500 11.5px/1 var(--vendo-font); color: var(--vendo-fg-muted); margin-top: 2px; }

/* ---- S-F attention vignette: a whisper-soft dim outside the point of
   attention — the ball while the agent speaks, the card once docked. */
.fl-voice-spot { position: absolute; inset: 0; pointer-events: none; z-index: 1; opacity: 0;
  background: radial-gradient(circle var(--fl-spot-r, 260px) at var(--fl-spot-x, 50%) var(--fl-spot-y, 30%),
    transparent 60%, color-mix(in srgb, var(--vendo-fg) 5%, transparent));
  transition: opacity .8s ease; }
.fl-voice-stage.is-spot-on .fl-voice-spot { opacity: 1; }

/* ---- C-A spoken-yes: the act-tier bar says voice works, with a live
   equalizer while the mic is open; a heard yes flips the hint. */
.fl-voice-consent-hint { font-size: 11px; color: var(--vendo-fg-muted); display: flex; align-items: center; }
.fl-voice-consent-hint.is-heard { color: var(--vendo-ok); font-weight: 600; }
.fl-voice-eq { display: inline-flex; gap: 2px; align-items: flex-end; height: 12px; margin-left: 6px; }
.fl-voice-eq i { width: 2.5px; height: 100%; border-radius: 2px; background: currentColor;
  animation: fl-voice-eq 1s ease-in-out infinite; }
.fl-voice-eq i:nth-child(1) { height: 60%; }
.fl-voice-eq i:nth-child(2) { animation-delay: .15s; }
.fl-voice-eq i:nth-child(3) { height: 45%; animation-delay: .3s; }
@keyframes fl-voice-eq { 0%, 100% { transform: scaleY(.5); } 50% { transform: scaleY(1); } }

/* ---- Cn-A connect-during-voice: the ConnectCard docks at the consent edge,
   centered (the approval card's max-width would left-hug a full-width slot),
   with the connecting hint stacked under the button as a caption. */
.fl-voice-connect { margin: 0 18px 8px; flex-shrink: 0; display: flex; justify-content: center; }
.fl-voice-connect .fl-approval { align-self: auto; width: 100%; margin-inline: auto;
  animation: fl-item-in .3s cubic-bezier(.22, 1, .36, 1) both; }

/* ---- M-A mobile safe-area foot: the controls clear the home indicator, and
   touch surfaces get real 48px targets. */
.fl-voice-foot { padding-bottom: max(12px, env(safe-area-inset-bottom, 0px) + 10px); }
@media (pointer: coarse) {
  .fl-voice-foot { padding: 10px 16px calc(env(safe-area-inset-bottom, 0px) + 20px); }
  .fl-voice-controls { gap: 10px; }
  .fl-voice-controls .fl-icon-btn { width: 48px; height: 48px; border-radius: 14px; }
  .fl-voice-controls .fl-btn { min-height: 48px; padding: 12px 26px; border-radius: 999px; font-size: 14px; }
  .fl-voice-drawer-btn { padding: 14px 10px; font-size: 12.5px; }
}

@media (prefers-reduced-motion: reduce) {
  .fl-voice-tick, .fl-voice-chip, .fl-voice-glow, .fl-voice-eq i { animation: none; }
  .fl-voice-spot { transition: none; }
  .fl-voice-stage:not(.is-docked) .fl-voice-blob { transition: none; }
}

/* ====================================================================
   ui-lane-thread block — the converged thread-surface picks (C1 ribbon,
   C5 bar pin, 2B/2C/2E/2F composer, 3A/3D list, 4B landing cards, 6B
   mobile jump, 8A-8E markdown). Derived from existing tokens only.
   ==================================================================== */

/* C1 — live status ribbon, tucked BEHIND the composer (one unit, Codex-
   style): narrower than the composer, top corners only, and its bottom edge
   slides under the card — the composer (position:relative) paints over the
   overlap, so the composer keeps its own full radius. The composer sits
   either adjacent or inside the dock anchor, so both DOM shapes lose their
   top margin. */
.fl-ribbon { display: flex; align-items: center; gap: 9px; margin: 0 30px -12px; padding: 7px 12px 19px;
  border: 1px solid var(--vendo-border); border-bottom: 0; border-radius: 14px 14px 0 0;
  background: color-mix(in srgb, var(--vendo-fg) 3%, var(--vendo-surface));
  font: 500 12.5px/1.3 var(--vendo-font); color: var(--vendo-fg-muted); }
.fl-ribbon + .fl-composer, .fl-ribbon + .fl-dock-anchor .fl-composer { margin-top: 0; }
/* The between-steps register: the orb rests (build calm), the label carries
   the "…" — same voice as an in-thread working beat. */
.fl-ribbon--working .fl-ribbon-label { color: var(--vendo-fg); }
.fl-ribbon .fl-beat-orb { width: 9px; height: 9px; }
.fl-ribbon-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--vendo-fg); font-weight: 550; }
@media (prefers-reduced-motion: no-preference) {
  .fl-ribbon { animation: fl-item-in var(--vendo-duration) var(--vendo-ease) both; }
  .fl-ribbon-label { animation: fl-fade-in .22s ease both; }
}
.fl-ribbon-time { flex-shrink: 0; font: 500 10.5px/1 var(--vendo-font-mono); color: var(--vendo-fg-muted);
  opacity: .75; font-variant-numeric: tabular-nums; }
.fl-ribbon-count { margin-left: auto; flex-shrink: 0; font: 600 10.5px/1.4 var(--vendo-font);
  border: 1px solid var(--vendo-border); border-radius: 999px; padding: 1px 7px; color: var(--vendo-fg-muted); }

/* C5 — the pin lives on the app-card bar once the view is ready (replaces the
   old footer row). Sits between the boot labels and the hairline. */
.fl-barpin { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0;
  cursor: pointer; border: 0; background: transparent; color: var(--vendo-fg-muted);
  font: 550 11.5px/1 var(--vendo-font); padding: 4px 8px; border-radius: 7px;
  transition: background .12s, color .12s; }
.fl-barpin:hover { background: var(--vendo-accent-soft); color: var(--vendo-fg); }
.fl-barpin:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 1px; }
@media (prefers-reduced-motion: no-preference) {
  .fl-appcard-bar[data-state="ready"] .fl-barpin { animation: fl-fade-in .3s ease both; }
}
/* The pin nudge (founder mockup, 2026-08-04). A settled build INVITES the pin
   with a slow ring at the edge of vision — never a toast, never an action, and
   never while the build is still running (§8 gives a build one moving thing).
   Taken, it resolves to the settled accent state. Reduced motion keeps the
   accent and drops the ring: the colour alone is the invitation. */
.fl-barpin[data-vendo-pin] { color: var(--vendo-accent); }
.fl-barpin[data-vendo-pin="pinned"] { background: var(--vendo-accent-soft); }
@media (prefers-reduced-motion: no-preference) {
  .fl-barpin[data-vendo-pin="invite"] { animation: fl-pin-nudge 2.4s var(--vendo-ease) infinite; }
  /* The card's pin also fades in with its bar (rule above); naming both keeps
     the entrance, which a bare nudge would silently replace. */
  .fl-appcard-bar[data-state="ready"] .fl-barpin[data-vendo-pin="invite"] {
    animation: fl-fade-in .3s ease both, fl-pin-nudge 2.4s var(--vendo-ease) infinite; }
}
@keyframes fl-pin-nudge {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--vendo-accent) 26%, transparent); }
  45% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--vendo-accent) 10%, transparent); } }

/* 2B — Send now on the queued pill. */
.fl-queued-now { flex-shrink: 0; border: 0; background: none; cursor: pointer; padding: 3px 6px;
  border-radius: 6px; font: 600 11px/1.2 var(--vendo-font); color: var(--vendo-accent); }
.fl-queued-now:hover { background: var(--vendo-accent-soft); }


/* 2E — the whole thread is the drop target; the overlay covers the surface
   with a centered card. (The composer-local .fl-drop geometry is superseded.) */
.fl-drop--thread { position: absolute; inset: 10px; z-index: 30; display: grid; place-items: center;
  border-radius: 16px; border: 1.5px dashed var(--vendo-accent);
  background: color-mix(in srgb, var(--vendo-accent) 7%, var(--vendo-surface)); }
.fl-drop-card { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center;
  color: var(--vendo-fg); font: 550 13px/1.4 var(--vendo-font); }
/* The drop surface needs a positioning context on the thread itself. */
.fl-thread { position: relative; }

/* 2F — attachment read ring + per-chip error with retry. */
.fl-att-ring { position: relative; width: 18px; height: 18px; flex-shrink: 0; }
.fl-att-ring svg { transform: rotate(-90deg); display: block; }
.fl-att-ring circle { fill: none; stroke-width: 2.6; }
.fl-att-ring-bg { stroke: var(--vendo-border); }
.fl-att-ring-fg { stroke: var(--vendo-accent); stroke-linecap: round; transition: stroke-dashoffset .2s linear; }
.fl-att-file--error { border-color: var(--vendo-danger-border); }
.fl-att-fail { color: var(--vendo-danger); font-size: 10.5px; }
.fl-att-retry { border: 0; background: none; padding: 0; cursor: pointer; font: inherit;
  color: var(--vendo-danger); text-decoration: underline; text-underline-offset: 2px; }

/* 3A — the new-replies bar docks FLUSH onto the composer (replaces .fl-jump).
   Rendered inside .fl-dock-anchor with the tray's geometry: the anchor's top
   is always exactly 10px above the bar's border edge, so bottom:
   calc(100% - 10px) seats the banner's bottom directly ON the composer's top
   border and left/right 16px matches the bar's margins — same width, no gap.
   The composer's top border is the ONE seam line (the banner keeps
   border-bottom: 0), its bottom corners square into it, and the shadow is
   flipped upward so nothing casts a second edge onto the bar below. */
.fl-newbar { position: absolute; left: 16px; right: 16px; bottom: calc(100% - 10px); display: flex;
  align-items: center; justify-content: center; gap: 8px; padding: 8px 12px; cursor: pointer;
  border: 1px solid var(--vendo-border); border-radius: 14px 14px 0 0; border-bottom: 0;
  background: var(--vendo-surface);
  font: 600 12px/1 var(--vendo-font); color: var(--vendo-fg);
  box-shadow: 0 -1px 2px color-mix(in srgb, var(--vendo-fg) 5%, transparent),
    0 -10px 28px color-mix(in srgb, var(--vendo-fg) 7%, transparent); }
/* While the banner shows, the bar squares its top corners so the two read as
   one card — same choreography as the connect tray above. */
.fl-dock-anchor:has(.fl-newbar) .fl-composer { border-top-left-radius: 0; border-top-right-radius: 0; }
@media (prefers-reduced-motion: no-preference) {
  .fl-newbar { animation: fl-newbar-rise .22s cubic-bezier(.22, 1, .36, 1) both; }
}
@keyframes fl-newbar-rise { from { transform: translateY(100%); } to { transform: none; } }
.fl-newbar:hover { border-color: var(--vendo-accent); }
.fl-newbar:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 2px; }
.fl-newbar small { color: var(--vendo-fg-muted); font-weight: 500; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; max-width: 55%; }
/* 6B — at phone widths (and in the takeover) the same affordance re-clothes as
   a bottom-center thumb pill floating just above the bar (which un-squares its
   corners: the :not(:has(.fl-tray)) guard keeps the tray's own squaring rule
   intact); the snippet yields to the count. Centered via
   auto margins, NOT translateX — the fl-newbar-rise entrance animates the
   transform property with fill:both, which would overwrite a transform-based centering
   and land the pill half off-center (AI-review catch). The two pill blocks
   below are intentionally identical — keep them in lockstep (a media query and
   a class selector can't share one declaration block in this sheet). */
@media (max-width: 480px) {
  .fl-newbar { left: 0; right: 0; bottom: calc(100% - 2px); margin: 0 auto; width: fit-content; max-width: calc(100% - 32px);
    border-radius: 999px; border-bottom: 1px solid var(--vendo-border);
    padding: 7px 14px; font-size: 11.5px; box-shadow: var(--vendo-shadow-float); }
  .fl-newbar small { display: none; }
  .fl-dock-anchor:has(.fl-newbar):not(:has(.fl-tray)) .fl-composer { border-top-left-radius: 14px; border-top-right-radius: 14px; }
}
/* mirror of the 480px pill block above — keep identical */
.fl-takeover .fl-newbar { left: 0; right: 0; bottom: calc(100% - 2px); margin: 0 auto; width: fit-content; max-width: calc(100% - 32px);
  border-radius: 999px; border-bottom: 1px solid var(--vendo-border);
  padding: 7px 14px; font-size: 11.5px; box-shadow: var(--vendo-shadow-float); }
.fl-takeover .fl-newbar small { display: none; }
.fl-takeover .fl-dock-anchor:has(.fl-newbar):not(:has(.fl-tray)) .fl-composer { border-top-left-radius: 14px; border-top-right-radius: 14px; }

/* 3D — fold-with-fade for restored huge bodies (user paste + markdown). */
.fl-fold { position: relative; }
.fl-fold:not(.fl-fold--open) { max-height: 190px; overflow: hidden; padding-bottom: 34px; }
.fl-fold-veil { position: absolute; left: 0; right: 0; bottom: 0; display: grid; place-items: end center;
  padding-bottom: 6px; height: 88px;
  background: linear-gradient(180deg, transparent, var(--vendo-user-bubble) 82%); }
.fl-turn-assistant .fl-fold-veil { background: linear-gradient(180deg, transparent, var(--vendo-bg) 82%); }
.fl-fold--open .fl-fold-veil { position: static; height: auto; background: none; padding: 8px 0 0; }
.fl-fold-pill { border: 1px solid var(--vendo-border-strong); border-radius: 999px;
  background: var(--vendo-surface);
  padding: 5px 12px; font: 600 11.5px/1.3 var(--vendo-font); color: var(--vendo-fg); cursor: pointer;
  box-shadow: var(--vendo-shadow-float); text-decoration: none; margin-top: 0; }
.fl-fold-pill:hover { border-color: var(--vendo-accent); }

/* 4B — starter cards on the landing (object suggestions). */
.fl-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px;
  width: 100%; max-width: 560px; }
/* Five(+) cards (2026-07 demo feedback): the grid would leave a hole in the
   last row — flex-wrap instead, so the trailing cards stretch edge-to-edge
   (3 up top, 2 wide below at the overlay's landing width). */
.fl-cards:has(> .fl-card:nth-child(5)) { display: flex; flex-wrap: wrap; }
.fl-cards:has(> .fl-card:nth-child(5)) > .fl-card { flex: 1 1 160px; min-width: 150px; }
.fl-card { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: left;
  cursor: pointer; border: 1px solid var(--vendo-border); border-radius: var(--vendo-radius);
  background: var(--vendo-surface);
  padding: 12px 13px; color: var(--vendo-fg);
  transition: border-color .14s, transform .18s cubic-bezier(.22, 1, .36, 1), box-shadow .18s; }
.fl-card:hover { border-color: var(--vendo-border-strong); transform: translateY(-1px);
  box-shadow: 0 2px 10px color-mix(in srgb, var(--vendo-fg) 8%, transparent); }
.fl-card:active { transform: translateY(0); box-shadow: none; }
.fl-card:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 2px; }
.fl-card b { font: 600 12.5px/1.3 var(--vendo-font); }
.fl-card span { font: 400 11.5px/1.45 var(--vendo-font); color: var(--vendo-fg-muted); }
.fl-card svg { color: var(--vendo-fg-muted); }

/* 8A — code header bar (Copy is always visible; overrides the hover reveal). */
.fl-codeblock { border: 1px solid var(--vendo-border); border-radius: 11px; overflow: hidden;
  background: var(--vendo-accent-soft); }
.fl-md .fl-codeblock pre { margin: 0; border: 0; border-radius: 0; background: none; }
.fl-codehead { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 13px;
  border-bottom: 1px solid var(--vendo-border); }
.fl-codehead-lang { font: 600 11px/1 var(--vendo-font-mono); color: var(--vendo-fg-muted); }
.fl-codehead-wrap { border: 0; background: none; cursor: pointer; margin-left: auto;
  font: 500 11px/1 var(--vendo-font); color: var(--vendo-fg-muted); padding: 4px 8px; border-radius: 6px; }
.fl-codehead-wrap:hover { background: var(--vendo-accent-soft); color: var(--vendo-fg); }
.fl-codehead-wrap--on { color: var(--vendo-accent); }
.fl-codehead .fl-copy { position: static; opacity: 1; }

/* 8B — ledger tables: no zebra, hairline rows, numerals aligned. */
.fl-md tbody tr:nth-child(even) { background: none; }
.fl-md th, .fl-md td { border-bottom: 1px solid var(--vendo-border); }
.fl-td-num { text-align: right; font-variant-numeric: tabular-nums; }

/* 8C (sources chip row) removed 2026-07 — settled read calls leave no
   transcript trace; the Activity panel is the record. */

/* 8D — collapsible sections in restored long replies. The h2/h3 wrapper keeps
   document-outline semantics; the button inside carries all the styling. */
.fl-mdsec { margin: 2px 0; }
.fl-mdsec-h { margin: 0; font-size: inherit; font-weight: inherit; line-height: inherit; }
.fl-mdsec-head { display: flex; align-items: center; gap: 7px; width: 100%; border: 0; background: none;
  padding: 4px 0; cursor: pointer; text-align: left;
  font: 650 1.05em/1.3 var(--vendo-font); color: var(--vendo-fg); }
.fl-mdsec-head svg { flex-shrink: 0; color: var(--vendo-fg-muted); transition: transform .16s; }
.fl-mdsec--open > .fl-mdsec-head svg { transform: rotate(90deg); }
.fl-mdsec-head:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 2px; border-radius: 6px; }
.fl-mdsec-body { padding: 2px 0 4px; }

/* 8E — a streaming table's forming row. */
.fl-tr-forming td { padding: var(--vendo-density-table-padding); }
.fl-tr-forming .fl-skeleton-bar { display: block; height: 9px; width: 62%; border-radius: 5px; }

/* ================= ui-lane-cards converged picks ================= */
/* 1-A · consequence-first approval. Distinct from .fl-approval-consequence
   (the amber voice-register line) — this is the neutral leading sentence. */
.fl-approval-consequence-line { margin: 10px 0 0; font: 500 13px/1.5 var(--vendo-font);
  color: var(--vendo-fg); }
.fl-approval-consequence-line strong { font-weight: 650; }
.fl-approval-details { margin-top: 2px; }
.fl-approval-details summary { color: var(--vendo-fg-muted); font-size: 11px; cursor: pointer;
  margin-top: 8px; }
.fl-approval-details summary:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 2px; }
.fl-approval-details[open] summary { margin-bottom: 2px; }

/* 1-H · mobile approval sheet. A consent surface: the scrim does NOT dismiss
   and Esc is a no-op (enforced in approval-sheet.tsx) — deciding is the only
   way out. Sits above the takeover panel and the palette scrim.
   NON-modal layering (voice-approval-overlap regression): only the sheet
   itself takes pointer events — the layer and the dimming scrim are
   hit-transparent, so surfaces behind them (the voice stage's Start button
   at short viewports) stay usable while a consent is pending. */
.fl-approval-sheet-layer { position: fixed; inset: 0; z-index: 2147483004;
  pointer-events: none; }
.fl-approval-sheet-scrim { position: absolute; inset: 0;
  background: color-mix(in srgb, var(--vendo-fg) 26%, transparent); }
.fl-approval-sheet { pointer-events: auto; }
.fl-approval-sheet { position: absolute; left: 0; right: 0; bottom: 0;
  border-radius: 18px 18px 0 0; background: var(--vendo-surface);
  box-shadow: 0 -12px 40px color-mix(in srgb, var(--vendo-fg) 22%, transparent);
  padding: 8px 16px calc(16px + env(safe-area-inset-bottom, 0px) + var(--fl-kb-inset, 0px));
  max-height: 86vh; overflow-y: auto; overscroll-behavior: contain; outline: none; }
.fl-approval-sheet-grabber { width: 36px; height: 4px; border-radius: 999px;
  background: var(--vendo-border-strong); margin: 4px auto 12px; }
/* Ancestors may SIZE the card, never undress it (spec §16 law 1): the sheet
   sets width only, so the same shell arrives here as in the thread and queue. */
.fl-approval-sheet .fl-approval { max-width: none; min-width: 0; width: 100%; }
@media (prefers-reduced-motion: no-preference) {
  .fl-approval-sheet { animation: fl-sheet-up .42s cubic-bezier(.22,1.1,.36,1) both; }
  .fl-approval-sheet-scrim { animation: fl-fade-in .3s ease both; }
}
@keyframes fl-sheet-up { from { transform: translateY(100%); } to { transform: none; } }
/* 1-H · thumb-zone decision buttons (same query as the ENG-228 block). */
@media (max-width: 767px), (pointer: coarse) {
  .fl-card-actions .fl-btn { padding: 14px 15px; font-size: 14px; flex: 1; }
}

/* 3-A′ · real brand marks in the tray rows (monogram = fallback). */
.fl-picker-ic img { width: 15px; height: 15px; object-fit: contain; display: block; }

/* 4-C · the morph docks into the Activity anchor; the anchor answers. */
@media (prefers-reduced-motion: no-preference) {
  .fl-tab--bump { animation: fl-tab-bump .55s cubic-bezier(.22,1,.36,1); }
}
@keyframes fl-tab-bump {
  0% { transform: scale(1); }
  40% { transform: scale(1.1); color: var(--vendo-fg); }
  100% { transform: scale(1); }
}

/* 7-A · automation liveness: countdown + the run dot traveling the arrow. */
.fl-auto-nextrun { font-variant-numeric: tabular-nums; }
.fl-automation .fl-auto-arrow { position: relative; }
.fl-auto-runner { position: absolute; top: -4.5px; left: 0; width: 8px; height: 8px;
  border-radius: 50%; background: var(--vendo-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vendo-accent) 18%, transparent); }
@media (prefers-reduced-motion: no-preference) {
  .fl-auto-runner { animation: fl-auto-travel 1.5s ease-in-out infinite; }
}
@keyframes fl-auto-travel { from { left: -2%; } to { left: 98%; } }
@media (prefers-reduced-motion: reduce) {
  /* The runner rests mid-arrow; the sheet arrives without motion. */
  .fl-auto-runner { animation: none; left: 46%; }
  .fl-approval-sheet { animation: fl-fade-in .18s ease both; }
}

/* Cross-lane reduced-motion sweep (review finding): entrance/pulse animations
   that were neither wrapped in a no-preference block nor listed in an explicit
   reduce kill — settle instantly at their end state for vestibular-sensitive
   users. (The data-vendo-motion="reduced" root rule already covers theme-level
   reduction; this covers the OS preference.) */
@media (prefers-reduced-motion: reduce) {
  .fl-overlay-scrim, .fl-toasts-card, .fl-voice-drawer,
  .fl-approvals-slide, .fl-auto-runs-dot, .fl-acct-severed { animation: none; opacity: 1; }
}

/* Knowledge K1 — the turn's knowledge trust surface (signed mockups,
   Surface 2): the labelled SOURCES chip row with the snippet popover, the
   muted searched-line refusal, and the amber knowledge-unavailable flag.
   Mockup --v-* values map to brand tokens only (theme.ts rule). */
.fl-cites { margin-top: 10px; }
.fl-cites-label { font-size: 10.5px; font-weight: 600; color: var(--vendo-fg-muted);
  text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
.fl-cites-row { display: flex; flex-wrap: wrap; gap: 6px; }
.fl-cite { position: relative; display: inline-flex; }
.fl-cite-btn { display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--vendo-border); background: var(--vendo-surface);
  border-radius: var(--vendo-radius-sm); padding: 4.5px 10px; font-family: inherit;
  font-size: 12px; font-weight: 500; color: var(--vendo-fg); cursor: pointer;
  transition: border-color .12s ease, background .12s ease; }
.fl-cite-btn svg { flex: none; color: var(--vendo-fg-muted); }
.fl-cite-btn:hover, .fl-cite--open .fl-cite-btn { border-color: var(--vendo-border-strong); }
/* The snippet popover: click-toggled everywhere, hover-revealed on pointer
   devices (the mockup's chip:hover behavior). */
.fl-cite-pop { position: absolute; left: 0; top: calc(100% + 8px); width: 292px; z-index: 5;
  background: var(--vendo-surface); border: 1px solid var(--vendo-border); border-radius: 10px;
  box-shadow: var(--vendo-shadow-float); padding: 12px 14px; text-align: left; cursor: default;
  display: none; }
.fl-cite--open .fl-cite-pop { display: block; }
@media (hover: hover) { .fl-cite:hover .fl-cite-pop { display: block; } }
.fl-cite-ptitle { font-size: 12.5px; font-weight: 600; color: var(--vendo-fg);
  display: flex; align-items: center; gap: 6px; }
.fl-cite-ptitle svg { color: var(--vendo-fg-muted); }
.fl-cite-psnippet { display: block; font-size: 12px; color: var(--vendo-fg-muted); line-height: 1.6;
  margin: 7px 0 9px; border-left: 2px solid var(--vendo-border); padding-left: 9px; }
.fl-cite-porigin { font-size: 11px; color: var(--vendo-fg-muted);
  display: flex; align-items: center; gap: 5px; }
.fl-cite-sep { color: var(--vendo-border-strong); }
.fl-know-searched { display: flex; align-items: center; gap: 7px; margin-top: 10px;
  font-size: 11.5px; color: var(--vendo-fg-muted); }
.fl-know-searched svg { flex: none; }
.fl-know-unavail { display: flex; align-items: flex-start; gap: 9px; margin-top: 10px;
  background: var(--vendo-warn-bg); border: 1px solid var(--vendo-warn-border);
  border-radius: 10px; padding: 9px 12px; font-size: 12px; line-height: 1.55;
  /* --vendo-warn, not the mockup's --vendo-warn-text tone: at 12px on the
     warn wash the lighter tone measures 4.38:1 — under the 4.5:1 AA floor
     (axe). The darker warn token keeps the amber register and passes. */
  color: var(--vendo-warn); }
.fl-know-unavail svg { flex: none; margin-top: 2px; }

/* ================== card shell (spec §16, one shell three laws) ==================
   The ONE geometry every consent/status card wears — approval, connect,
   standing-access, automation, adoption, resolved — on every surface (thread,
   queue, activities, sheet, voice, embeds, center). Contents differ; geometry
   never does. Components land in Lane B (chrome/card-shell.tsx).

   Law 1: ancestors may set width/max-width on .fl-cardshell, nothing else.
   Law 2: ONE icon well size (28px), ONE primary button (.fl-btn-primary),
          ONE ceremony button (.fl-btn-ceremony).
   Law 3: the plain-words line is mandatory — it has a rule, so it has a slot. */
.fl-cardshell { display: flex; flex-direction: column; box-sizing: border-box;
  padding: 16px 18px; border: 1px solid var(--vendo-border); border-radius: var(--vendo-radius-card);
  background: var(--vendo-surface); color: var(--vendo-fg);
  font: 400 var(--vendo-text-body)/1.5 var(--vendo-font); }
/* The destructive register: an amber edge bar over the same neutral card. */
.fl-cardshell--ceremony { border-color: var(--vendo-warn-border);
  box-shadow: inset 3px 0 0 var(--vendo-warn); }
/* Settled — the card is a receipt, not an ask. */
.fl-cardshell--settled { color: var(--vendo-fg-muted); }

.fl-card-head { display: flex; align-items: flex-start; gap: 11px; min-width: 0; }
/* The copy column. min-width:0 stops a long unbroken title from refusing to
   shrink and pushing the card past its own border. */
.fl-card-heading { min-width: 0; flex: 1; }
/* The ONE icon well. Every card kind, every surface — 28px, no exceptions. */
.fl-card-ic { display: grid; place-items: center; width: 28px; height: 28px; flex-shrink: 0;
  border-radius: var(--vendo-radius); overflow: hidden;
  color: var(--vendo-accent); background: var(--vendo-accent-soft); }
.fl-card-ic img { width: 100%; height: 100%; object-fit: contain; display: block; }
.fl-card-eyebrow { font: 600 10.5px/1 var(--vendo-font); letter-spacing: .05em;
  text-transform: uppercase; color: var(--vendo-fg-muted); }
.fl-cardshell--ceremony .fl-card-eyebrow { color: var(--vendo-warn); }
.fl-cardshell--ceremony .fl-card-ic { color: var(--vendo-warn);
  background: color-mix(in srgb, var(--vendo-warn) 16%, transparent); }
.fl-card-title { margin-top: 4px; font: 600 13.5px/1.3 var(--vendo-heading-font); color: var(--vendo-fg);
  letter-spacing: -.01em; overflow-wrap: anywhere; }
/* The mandatory plain-words line: what this DOES, in the user's language. */
.fl-card-line { margin: 10px 0 0; font: 500 13px/1.5 var(--vendo-font); color: var(--vendo-fg); }
.fl-card-line strong { font-weight: 650; }

.fl-card-fields { margin: 12px 0 0; padding: 10px 0 2px; border-top: 1px solid var(--vendo-border);
  display: flex; flex-direction: column; gap: 7px; }
.fl-card-field { display: grid; grid-template-columns: minmax(88px, auto) 1fr; gap: 12px;
  font-size: 12.5px; line-height: 1.45; }
.fl-card-field dt { color: var(--vendo-fg-muted); }
/* pre-line: object/array inputs arrive as compact one-per-line \`Key: value\`
   text (field-rows.ts) rather than raw JSON. */
.fl-card-field dd { margin: 0; color: var(--vendo-fg); overflow-wrap: anywhere; white-space: pre-line; }
/* Money and counts right-align on tabular figures so a column of amounts
   reads as a column. Set by the shell when the value is numeric. */
.fl-card-field dd[data-numeric] { text-align: right; font-variant-numeric: tabular-nums; }

.fl-card-list { list-style: none; margin: 12px 0 0; padding: 0;
  display: flex; flex-direction: column; }
.fl-card-list > li { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 11px;
  align-items: center; padding: 9px 0; border-top: 1px solid var(--vendo-border); }
.fl-card-list > li:first-child { border-top: 0; padding-top: 2px; }

.fl-card-actions { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
/* The byline: who/what is asking, or when it settled. Always last, always quiet. */
.fl-card-byline { margin-top: 10px; font-size: 11.5px; color: var(--vendo-fg-muted); }

/* ============================ LANE C ============================
   The transcript shows the work (spec §1 + §8 D1 + §15). The beat vocabulary
   itself lives above (.fl-beat*); this section adds the two pieces the settled
   transcript needed: the result a beat earned, and the row a finished turn
   folds into. */

/* "Reading transactions · 142 transactions" — the count trails the label a
   step quieter, so the eye reads the work first and the receipt second. */
.fl-beat-result { flex-shrink: 0; font-weight: 400; color: var(--vendo-fg-muted); }

/* The settled turn's one reopenable row: reads as a beat (same rhythm, same
   tick, same indent), behaves as a disclosure. */
.fl-beatsummary { align-self: flex-start; display: flex; align-items: center; gap: 9px;
  margin: 0; padding: 3px 2px; border: 0; background: none; cursor: pointer;
  font: 500 13px/1.35 var(--vendo-font); color: var(--vendo-fg-muted); text-align: left; }
.fl-beatsummary:hover { color: var(--vendo-fg); }
.fl-beatsummary:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 2px;
  border-radius: var(--vendo-radius-sm); }

/* No entrance stampede: a restored turn already carries .fl-no-entrance, and
   reopening one mounts its whole checklist in a single commit — N fade-ins at
   once is the opposite of calm. */
.fl-no-entrance .fl-beat { animation: none; }

/* ---------- the workspace beat rail (§3.4 + §10.2) ----------
   A heavy build is watched as an accumulating vertical list of the SAME beat
   line the transcript uses, on the existing split-view stage. Sits under
   whatever the stage is showing, above the pane's bottom edge. */
.fl-beatrail { flex: none; padding: 14px 18px 16px; border-top: 1px solid var(--vendo-border); }
.fl-beatrail-head { margin: 0 0 10px; font: 600 11px/1 var(--vendo-font); letter-spacing: .055em;
  text-transform: uppercase; color: var(--vendo-fg-muted); }
.fl-beats { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
/* The caption is the point of the rail: watching is optional. */
.fl-beatrail-cap { margin: 12px 0 0; max-width: 42ch;
  font: 400 11.5px/1.45 var(--vendo-font); color: var(--vendo-fg-muted); }
/* The rail's own register — the mockup's 6px pip. In the TRANSCRIPT the orb is
   a static position marker (§8 build calm, where the card is the step and the
   boot hairline is the one moving thing); a rail with no card and no hairline
   has nothing else to say "still going", so here the pip carries the pulse. */
.fl-beatrail .fl-beat-orb { width: 6px; height: 6px; background: var(--vendo-accent); }
@media (prefers-reduced-motion: no-preference) {
  .fl-beatrail .fl-beat-working .fl-beat-orb { animation: fl-beat-pip 1.5s var(--vendo-ease) infinite; }
}
@keyframes fl-beat-pip { 50% { opacity: .35; transform: scale(.82); } }

/* ================== LANE B — card-shell surfaces (spec §16, §4) ==================
   Nothing here dresses or undresses a card: it sizes the shell inside each
   ancestor (law 1) and styles the two containers the shell lives in. */

/* N1 — the waiting strip is COUNT-FIRST: a slim summary row that expands the
   shell cards in place. Native <details>, so no state and no JS. */
.fl-waiting-strip > summary { display: flex; align-items: center; gap: 8px; cursor: pointer;
  list-style: none; font: 600 11px/1 var(--vendo-font); letter-spacing: .04em;
  text-transform: uppercase; color: var(--vendo-fg-muted); }
.fl-waiting-strip > summary::-webkit-details-marker { display: none; }
.fl-waiting-strip > summary:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 3px; border-radius: 4px; }
.fl-waiting-strip > summary::after { content: ""; width: 6px; height: 6px; margin-left: auto;
  border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg); transition: transform var(--vendo-duration) var(--vendo-ease); }
.fl-waiting-strip[open] > summary { margin-bottom: 10px; }
.fl-waiting-strip[open] > summary::after { transform: rotate(225deg); }
.fl-waiting-cards { display: flex; flex-direction: column; gap: 8px; }
/* Law 1 — the ancestors that size the shell (width only, never its dress):
   the strip, the mobile sheet, and the activities stack. */
.fl-waiting-cards > .fl-cardshell,
.fl-approval-sheet .fl-cardshell,
.fl-approvals-stack .fl-cardshell { width: 100%; max-width: none; min-width: 0; }
/* The automation card's flow nodes are CONTENTS now: the panel's padded block
   loses its own box because the shell owns the padding. */
.fl-cardshell > .fl-auto-flow { margin-top: 12px; padding: 12px 0 0; }
/* The morph pill's mark comes from the shared <ToolkitLogo> (which owns the
   onError fallback), so its size rides the CSS instead of img attributes. */
.fl-morph-logo img, .fl-morph-logo svg { display: block; width: 18px; height: 18px; object-fit: contain; }

/* ---------- LANE D — background attention (spec §2 G1, §3 H1, §4 N1) ---------- */
/* The pill while a run keeps going without the user: the morph blob gives way
   to a progress ring and the label to the live beat. Nothing here opens or
   folds a surface — the pill only tells the truth about what is happening. */
.fl-launcher-ring { width: 18px; height: 18px; flex: none; border-radius: 50%;
  /* One element, two rings: --fl-ring is the filled fraction (determinate),
     and the indeterminate variant below swaps in a fixed arc that turns. */
  background: conic-gradient(var(--vendo-accent) var(--fl-ring, 0%), var(--vendo-border-strong) 0);
  mask: radial-gradient(closest-side, transparent 60%, #000 62%);
  -webkit-mask: radial-gradient(closest-side, transparent 60%, #000 62%);
  transition: background var(--vendo-duration) var(--vendo-ease); }
.fl-launcher-ring[data-vendo-ring="indeterminate"] {
  background: conic-gradient(var(--vendo-accent) 0 22%, var(--vendo-border-strong) 22% 100%); }
.fl-launcher-beat { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The two standing signals. A count is a decision waiting on you; the dot is
   only "there is something new" — so the count always wins the corner. */
.fl-launcher-badge { min-width: 18px; height: 18px; padding: 0 5px; flex: none;
  display: inline-grid; place-items: center; border-radius: 999px;
  background: var(--vendo-accent); color: var(--vendo-accent-fg);
  font-size: 11px; font-weight: 650; font-variant-numeric: tabular-nums; }
.fl-launcher-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--vendo-accent); }
/* Blob-only orb (label: null): the signals ride the corner instead of widening
   the circle. The fixed corner variants are their own containing block. */
.fl-launcher[data-vendo-launcher-bare] .fl-launcher-badge { position: absolute; top: -3px; right: -3px; }
.fl-launcher[data-vendo-launcher-bare] .fl-launcher-dot { position: absolute; top: 3px; right: 3px; }
/* The completion toast rides above the pill it came from, in the corner the
   user last saw working — never a center-screen modal. */
.fl-launcher-toast { display: flex; align-items: center; gap: 10px; max-width: 300px;
  padding: 10px 10px 10px 14px; border: 1px solid var(--vendo-border); border-radius: 14px;
  background: var(--vendo-surface); box-shadow: var(--vendo-shadow-float);
  font-size: 12.5px; line-height: 1.45; color: var(--vendo-fg);
  position: fixed; z-index: 2147482999; bottom: calc(72px + env(safe-area-inset-bottom, 0px)); }
.fl-launcher-toast[data-vendo-launcher="bottom-right"] { right: calc(20px + env(safe-area-inset-right, 0px)); }
.fl-launcher-toast[data-vendo-launcher="bottom-left"] { left: calc(20px + env(safe-area-inset-left, 0px)); }
.fl-launcher-toast-head { flex: 1; min-width: 0; font-weight: 550;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.fl-launcher-toast-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.fl-launcher-toast-x { display: grid; place-items: center; width: 24px; height: 24px; padding: 0;
  border: 0; border-radius: 8px; background: none; color: var(--vendo-fg-muted); cursor: pointer; }
.fl-launcher-toast-x:hover { color: var(--vendo-fg); background: var(--vendo-accent-soft); }
@media (prefers-reduced-motion: no-preference) {
  /* The ONE moving part of the closed-panel state: the indeterminate arc. */
  .fl-launcher-ring[data-vendo-ring="indeterminate"] { animation: fl-ring-turn 1.4s linear infinite; }
  .fl-launcher-beat { animation: fl-beat-in var(--vendo-duration) var(--vendo-ease) both; }
  .fl-launcher-toast { animation: fl-toast-in var(--vendo-duration) var(--vendo-ease) both; }
}
@keyframes fl-ring-turn { to { transform: rotate(360deg); } }
@keyframes fl-beat-in { from { opacity: 0; filter: blur(4px); } to { opacity: 1; filter: none; } }
@keyframes fl-toast-in { from { opacity: 0; transform: translateY(10px); filter: blur(5px); }
  to { opacity: 1; transform: none; filter: none; } }

/* ================== LANE F — the AI center (spec §10 X1, §12, §14) ==================
   The full-page workspace wears the ChatGPT SHAPE in the host's brand: an
   in-page rail beside one centered column. It is a PAGE inside the host's app
   (§12) — no brand row, no user row, no app frame of our own — so everything
   here is layout and quiet, and the host's chrome carries the identity. */
.fl-center { display: grid; grid-template-columns: minmax(210px, 248px) minmax(0, 1fr);
  height: 100%; min-height: 0; background: var(--vendo-bg); }

/* ---- the rail ---- */
.fl-rail { display: flex; flex-direction: column; min-height: 0; overflow-y: auto;
  padding: 14px 10px 20px; border-right: 1px solid var(--vendo-border); scrollbar-width: thin; }
.fl-rail-nav { display: flex; flex-direction: column; gap: 2px; }
/* Airy rows at 14.5px (S1): the rail is navigation, so it never competes with
   the column for attention — the selected row is a soft fill, not a bar. */
.fl-rail-row { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px;
  border: 0; border-radius: var(--vendo-radius); background: transparent; color: var(--vendo-fg-muted);
  font: 500 14.5px/1.25 var(--vendo-font); text-align: left; cursor: pointer;
  transition: background .14s, color .14s; }
.fl-rail-row:hover { background: color-mix(in srgb, var(--vendo-fg) 4%, transparent); color: var(--vendo-fg); }
.fl-rail-row[aria-selected="true"], .fl-rail-row[aria-current="page"] {
  background: color-mix(in srgb, var(--vendo-fg) 6%, transparent); color: var(--vendo-fg); }
/* The selected state cannot BE the 6% fill: at ~1.1:1 it is invisible to a good
   many people and fails 1.4.11 outright. The fill stays as the soft ground; the
   mark that carries the meaning is this bar, derived at 3:1+. */
.fl-rail-row[aria-selected="true"]::before, .fl-rail-row[aria-current="page"]::before,
.fl-rail-chat[aria-current="page"]::before { content: ""; position: absolute; left: 2px; top: 50%;
  width: 2.5px; height: 15px; margin-top: -7.5px; border-radius: 2px; background: var(--vendo-indicator); }
.fl-rail-row:focus-visible, .fl-rail-chat:focus-visible, .fl-rail-more:focus-visible,
.fl-tile-hit:focus-visible, .fl-tile--ghost:focus-visible, .fl-center-head-btn:focus-visible {
  outline: 2px solid var(--vendo-accent); outline-offset: 2px; }
.fl-rail-row svg { flex: none; opacity: .7; }
/* The quiet ··· row: Activity and Accounts are receipts and plumbing, not doors
   — they belong one gesture away, never in the primary three. */
.fl-rail-more { align-self: flex-start; margin: 3px 0 2px; padding: 5px 12px; border: 0;
  border-radius: var(--vendo-radius-sm); background: transparent; color: var(--vendo-fg-muted);
  font: 500 15px/1 var(--vendo-font); cursor: pointer; transition: background .14s, color .14s; }
.fl-rail-more:hover { background: color-mix(in srgb, var(--vendo-fg) 4%, transparent); color: var(--vendo-fg); }
.fl-rail-group { display: flex; flex-direction: column; gap: 1px; margin-top: 16px; }
.fl-rail-label { display: flex; align-items: center; gap: 7px; margin: 0 0 5px; padding: 0 10px;
  font: 600 10.5px/1 var(--vendo-font); letter-spacing: .05em; text-transform: uppercase;
  color: var(--vendo-fg-muted); }
/* §4 — attention is a NUMBER, and the section it sits on exists only while
   something is actually waiting. */
.fl-rail-badge { display: inline-grid; place-items: center; min-width: 17px; height: 17px; padding: 0 5px;
  border-radius: 999px; background: var(--vendo-accent); color: var(--vendo-accent-fg);
  font: 600 10.5px/1 var(--vendo-font); letter-spacing: 0; }
/* One line, ellipsized in CSS (never truncated in JS — the full opening line
   stays available to assistive tech and to a wider rail). */
.fl-rail-chat { position: relative; display: block; width: 100%; padding: 8px 24px 8px 10px;
  border: 0; border-radius: var(--vendo-radius); background: transparent; color: var(--vendo-fg);
  font: 460 14.5px/1.35 var(--vendo-font); text-align: left; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background .14s; }
.fl-rail-chat:hover { background: color-mix(in srgb, var(--vendo-fg) 4%, transparent); }
.fl-rail-chat[aria-current="page"] { background: color-mix(in srgb, var(--vendo-fg) 6%, transparent);
  font-weight: 600; }
.fl-rail-need { color: var(--vendo-fg-muted); }
/* The running-turn pulse, on the row the turn belongs to — marked by the page
   from the run-activity store (data-vendo-running). It used to require
   aria-current="page", which meant the ONE row it could never mark was a
   BACKGROUND one: §10's promise ("a running background turn shows a quiet pulse
   on its row") was undeliverable as written. */
.fl-rail-pulse { display: none; position: absolute; top: 50%; right: 9px; width: 6px; height: 6px;
  margin-top: -3px; border-radius: 50%; background: var(--vendo-accent); }
.fl-rail-chat[data-vendo-running] .fl-rail-pulse { display: block; }
@media (prefers-reduced-motion: no-preference) {
  .fl-rail-chat[data-vendo-running] .fl-rail-pulse {
    animation: fl-rail-pulse 1.6s ease-in-out infinite; }
}
@keyframes fl-rail-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }

/* ---- the column ---- */
.fl-center-main { position: relative; flex: 1; display: flex; flex-direction: column;
  min-width: 0; min-height: 0; }
.fl-center-main > [hidden] { display: none; }
.fl-center-col { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.fl-center-thread { flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* The centered column caps at ~660px (S1: generous margins, one reading
   measure) — the thread and its composer share the same axis. */
.fl-center-thread > .vendo-root, .fl-center-thread .fl-thread {
  width: 100%; max-width: 660px; margin: 0 auto; }
.fl-center-col > .vendo-root:has(> .fl-waiting) { width: 100%; max-width: 660px; margin: 0 auto; }

/* Suggestions are ROWS on the home, never generic chips (§11): a noticing reads
   as a line you could have said, with its icon, full width. Restyled in place —
   the thread keeps rendering the host's own \`suggestions\`. */
/* On the home the greeting and its rows GATHER above the shelf rather than
   floating in the middle of the column: everything the eye needs sits in one
   block over the composer. */
.fl-center-home .fl-landing { justify-content: flex-end; padding-bottom: 18px; }
.fl-center-home .fl-cards { display: flex; flex-direction: column; gap: 6px; max-width: none; }
.fl-center-home .fl-card { flex-direction: row; align-items: center; gap: 10px; width: 100%;
  padding: 12px 14px; border-radius: var(--vendo-radius-card); }
.fl-center-home .fl-card b { font-size: 13.5px; font-weight: 500; }
.fl-center-home .fl-card span:empty { display: none; }
.fl-center-home .fl-chips { flex-direction: column; align-items: stretch; gap: 6px; width: 100%; }
.fl-center-home .fl-chip { display: flex; align-items: center; gap: 10px; padding: 12px 14px;
  border-radius: var(--vendo-radius-card); font-size: 13.5px; text-align: left; }
.fl-center-home .fl-chip::before { content: "✦"; color: var(--vendo-fg-muted); font-size: 12px; }

/* ---- the app shelf: apps as LIVE tiles (§10 pick HB) ---- */
.fl-shelf { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px;
  margin: 0 auto; padding: 0 30px 4px; width: 100%; max-width: 660px; }
.fl-shelf--grid { max-width: none; padding: 0; gap: 18px; }
/* A tile is a CONTROL (its whole face opens the app), so its edge is the thing
   that says where the control is — the 8% hairline left that at ~1.15:1. */
.fl-tile { position: relative; display: flex; flex-direction: column; overflow: hidden; text-align: left;
  border: 1px solid var(--vendo-indicator); border-radius: var(--vendo-radius-card);
  background: var(--vendo-surface);
  transition: transform var(--vendo-duration) var(--vendo-ease), box-shadow var(--vendo-duration) var(--vendo-ease); }
/* Hover-lift is one of the two places shadow is allowed to appear (S1). */
.fl-tile:hover { transform: translateY(-2px); box-shadow: var(--vendo-shadow-float); }
/* The preview is the app's REAL surface, scaled down and made unreachable: a
   tile's affordance is "open this", never "use this at 40%". */
.fl-tile-view { position: relative; height: 124px; overflow: hidden; pointer-events: none;
  border-bottom: 1px solid var(--vendo-border); }
.fl-tile-scale { display: block; width: 250%; height: 250%; transform: scale(.4); transform-origin: top left; }
.fl-tile-hit { position: absolute; inset: 0; border: 0; background: transparent; cursor: pointer; }
.fl-tile-cap { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 7px;
  padding: 10px 12px; }
.fl-tile-name { font: 550 13.5px/1.35 var(--vendo-heading-font); color: var(--vendo-fg);
  overflow-wrap: anywhere; }
.fl-tile-hint { color: var(--vendo-fg-muted); font-size: 11.5px; line-height: 1.45; }
/* The faint "a view goes here" ground, shared by a loading tile and a ghost. */
.fl-tile-skel { display: block; height: 124px;
  background: repeating-linear-gradient(180deg, transparent 0 16px,
    color-mix(in srgb, var(--vendo-fg) 5%, transparent) 16px 23px); }
/* §14 CS2 — day zero the shelf ADVERTISES: dashed ghosts naming what to build,
   retired for good the moment a real app exists. */
.fl-tile--ghost { cursor: pointer; padding: 0; border-style: dashed; background: transparent; }
.fl-tile--ghost:hover { transform: translateY(-2px); box-shadow: none;
  border-color: var(--vendo-border-strong); }
.fl-tile--ghost .fl-tile-skel { height: 92px; opacity: .8; }

/* ---- the named doors (Apps / Automations / the ··· panels) ---- */
.fl-center-page { flex: 1; min-height: 0; overflow-y: auto; width: 100%; max-width: 780px;
  margin: 0 auto; padding: 28px 26px 34px; display: flex; flex-direction: column; gap: 9px; }
.fl-center-title { margin: 0; font: 500 22px/1.2 var(--vendo-heading-font); letter-spacing: -.018em; }
.fl-center-cap { margin: 0 0 6px; color: var(--vendo-fg-muted); font-size: 13px; }
.fl-center-empty { margin: 10px 0 0; color: var(--vendo-fg-muted); font-size: 13.5px; }
/* "ask below to build a new one" — the ask sits where the composer sits. */
.fl-center-ask { display: flex; align-items: flex-end; gap: 8px; margin-top: auto; padding-top: 22px; }
.fl-center-ask-field { flex: 1; display: flex; flex-direction: column; }
.fl-center-ask-field .fl-picker-group { margin: 0 2px 7px; }
/* Room to breathe (§10 "with room to breathe"): the per-app verbs are ONE quiet
   line of text under the name — four bordered pills wrapped onto two rows and
   turned every tile into a toolbar, and hiding them until hover only traded the
   clutter for a dead band of reserved space. */
.fl-tile-acts { display: flex; flex-wrap: wrap; gap: 12px; }
/* An app with no view of its own (an automation) says so, rather than resting
   forever on a skeleton that pretends one is coming. */
.fl-tile-none { display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 7px; height: 100%; color: var(--vendo-fg-muted); font-size: 11.5px; }
.fl-tile-act { border: 0; padding: 0; background: transparent; color: var(--vendo-fg-muted);
  font: 500 11.5px/1.4 var(--vendo-font); cursor: pointer; transition: color .14s; }
.fl-tile-act:hover { color: var(--vendo-fg); }
.fl-tile-act--ceremony:hover { color: var(--vendo-warn); }
.fl-tile-act:focus-visible { outline: 2px solid var(--vendo-accent); outline-offset: 2px; }
.fl-tile-form { display: flex; align-items: center; gap: 6px; }
.fl-tile-form .fl-picker-search { margin-bottom: 0; }
/* An app open FULL in the column, with the way back stated plainly. */
.fl-center-open { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.fl-center-open-top { display: flex; align-items: center; gap: 12px; flex: none;
  padding: 12px 16px; border-bottom: 1px solid var(--vendo-border); }
.fl-center-open-name { font: 550 13.5px/1 var(--vendo-heading-font); }

/* ---- mobile P1 (§12): ONE self-contained page under the host's own tab ---- */
.fl-center--mobile { position: relative; display: flex; flex-direction: column; }
.fl-center-head { display: flex; align-items: center; gap: 6px; flex: none;
  padding: 6px 10px; border-bottom: 1px solid var(--vendo-border); }
.fl-center-head-title { margin-right: auto; padding-left: 4px;
  font: 550 15px/1 var(--vendo-heading-font); letter-spacing: -.012em; }
.fl-center-head-nav { display: flex; align-items: center; gap: 2px; overflow-x: auto; scrollbar-width: none; }
.fl-center-head-nav::-webkit-scrollbar { display: none; }
.fl-center-head-btn { display: inline-flex; align-items: center; min-height: 44px; padding: 0 10px;
  border: 0; border-radius: var(--vendo-radius-sm); background: transparent; color: var(--vendo-fg-muted);
  font: 500 13px/1 var(--vendo-font); white-space: nowrap; cursor: pointer; }
/* Same reasoning as the rail rows: the 6% ground plus a mark that can be seen. */
.fl-center-head-btn[aria-current="page"] { color: var(--vendo-fg);
  background: color-mix(in srgb, var(--vendo-fg) 6%, transparent);
  box-shadow: inset 0 -2px 0 var(--vendo-indicator); }
.fl-center-head-new { color: var(--vendo-fg); }
.fl-center-scrim { position: absolute; inset: 0; z-index: 3;
  background: color-mix(in srgb, var(--vendo-fg) 22%, transparent);
  animation: fl-takeover-fade .18s ease both; }
.fl-center-sheet { position: absolute; top: 0; bottom: 0; left: 0; z-index: 4;
  width: min(86%, 320px); display: flex; flex-direction: column; overflow-y: auto;
  padding: 10px 10px 18px; background: var(--vendo-surface);
  border-right: 1px solid var(--vendo-border); box-shadow: var(--vendo-shadow-float);
  animation: fl-sheet-in var(--vendo-duration) var(--vendo-ease) both; }
@keyframes fl-sheet-in { from { transform: translateX(-100%); } to { transform: none; } }
.fl-center-sheet-top { display: flex; justify-content: flex-end; }
.fl-center-sheet .fl-rail-nav { margin-top: 18px; padding-top: 12px;
  border-top: 1px solid var(--vendo-border); }
/* M2 respects the OS (spec §6): everything the center added that MOVES is off
   under prefers-reduced-motion — the sheet's full-width slide (the largest
   travel in the wave), its scrim fade, the tile hover-lift, and the waiting
   strip's disclosure chevron. The hover SHADOW stays: it is depth, not motion. */
@media (prefers-reduced-motion: reduce) {
  .fl-center-sheet, .fl-center-scrim { animation: none; }
  .fl-tile { transition: box-shadow var(--vendo-duration) var(--vendo-ease); }
  .fl-tile:hover, .fl-tile--ghost:hover { transform: none; }
  .fl-waiting-strip > summary::after { transition: none; }
}

/* Stacked home: two tiles across at phone widths, shorter previews. */
.fl-center--mobile .fl-shelf { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px;
  max-width: none; padding: 0 14px 4px; }
.fl-center--mobile .fl-tile-view, .fl-center--mobile .fl-tile-skel { height: 92px; }
.fl-center--mobile .fl-tile--ghost .fl-tile-skel { height: 66px; }
.fl-center--mobile .fl-center-page { padding: 18px 16px 26px; }
.fl-center--mobile .fl-center-thread .fl-thread { max-width: none; }

`;

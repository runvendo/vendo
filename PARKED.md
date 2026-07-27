# PARKED — extraction-quality-1

Items the contract's anti-overfit law forbids fixing: no general
deterministic rule exists, and the remaining lever is prompt text aimed
at named corpus repos — the overfitting we refuse (v2-generalize lesson).

## Task 4a: vercel-commerce accent — expected #000000, got #155dfc

Source read at pinned 3761e52e: `app/globals.css` declares NO brand
tokens at all (no shadcn sheet — just preflight tweaks). The brand color
evidence lives entirely in utility classes, and it is BLUE, not black:
`components/cart/add-to-cart.tsx:19` and `components/cart/modal.tsx:249`
paint the primary CTAs `bg-blue-600`, `components/product/variant-selector.tsx:90`
rings actives with `ring-blue-600`, `components/label.tsx:29` badges with
`bg-blue-600` (~10 usages). #155dfc IS Tailwind v4 blue-600 — the model
answered the dominant interactive color exactly as the slot semantics
("the brand's primary interactive color... primary buttons are painted
with it") define it.

Why no deterministic fix: the contract's candidate rule — "monochrome
detection from the sheet's saturation profile" — reads the token sheet,
and this repo has no token sheet. A rule "no saturated sheet token →
accent = ink/black" would get vercel-commerce's label right ONLY by
ignoring the strongest source evidence (blue CTAs); its counter-example
is any tokenless host with colored CTAs (that rule would paint them
black — a silent wrong brand, the exact failure class the exact-or-model
split exists to prevent). The only remaining lever is prompt text that
demotes utility-class CTA colors below a monochrome assumption — a
judgment change aimed at making this one repo pass, i.e. overfitting.

Also noting for the conductor: the #000000 label itself is a judgment
call that the pinned source does not obviously support (labeling law
says read the source; the source's primary interactive color is
blue-600). The label was NOT edited — never bent toward extractor
output — but this miss may be a labeling question, not an extraction
one.

## Task 4b: vercel-commerce radius — expected 8px, got 9999px

No `--radius` token exists in the repo; the model answered from usage.
Usage at the pinned SHA is genuinely mixed: primary CTAs are pills
(`rounded-full` — add-to-cart.tsx:19, modal.tsx:249), tiles/cards are
`rounded-lg` (tile.tsx:23), small controls `rounded-md`/`rounded-sm`
(open-cart.tsx:21, others). The stages rule already says radius is the
default CONTROL radius; buttons here ARE pills, so 9999px is a faithful
read of the buttons. Getting 8px requires either (a) a new
utility-class-scan derivation pass whose tiebreak (inputs-over-buttons,
or mode-excluding-pills) is supported by exactly one repo's evidence —
and whose mode here would arguably be rounded-md (6px), not the labeled
8px — or (b) a prompt tweak ("pills don't count") aimed at this repo.
Both fail the general-rule bar. Parked.

## Task 4c: umami radius — expected 6px, got 8px

The 6px radius token does not exist in umami's own tree at pinned
af1b6c6e: `src/app/global.css` declares only font/primary vars (and
references `--border-radius-full` it never defines). The control radius
lives inside the vendor package `@umami/react-zen`'s stylesheet
(`styles.full.css`, imported in `src/app/layout.tsx:7`). The theme
gatherer deliberately does not chase package-specifier CSS
(extract-theme.ts resolveLocalSpec: "host brand tokens live in the
host's own tree") — vendor sheets carry hundreds of library tokens that
are not the host's brand, and reading them would trade this one hit for
a class of wrong-brand exact claims. The extraction correctly reported
radius as DEFAULTED (visible miss, 8px neutral default) rather than
silently wrong. A general fix would mean reversing the vendor-CSS
ownership rule on one repo's evidence. Parked; recorded in
corpus/expectations/umami/notes.md.

## Task 6: umami/papermark annotations.match partials — static path proven clean; per-tool sampling needs the mini artifacts

Offline reproduction (this lane, 2026-07-26): pinned clones (umami
af1b6c6e, papermark 749f69ef) run through the EXACT static extractor
(`runExtractors`) and joined with the scorer's own identity/risk logic
(actualToolIdentity + the annotations join from scored.ts) give
**umami 147/147 and papermark 384/384** — zero label gaps, zero static
extractor misses. `git log e0edd16a..HEAD -- packages/actions/src` is
EMPTY, so the nightly (vendo @ e0edd16a) ran this identical static
extractor.

Therefore the nightly's 140/147 and 349/384 can only have been produced
by the one risk-mutating stage between static extraction and tools.json:
the consent-gated AI enrichment pass (the mini runs init --ai-polish
with a live key; risk changes are raise-only by pinned law). The 7 + 35
mismatches are read-labeled tools whose risk the model raised (or
model-run-specific judgment variance).

Why parked: the per-tool sample the task asks for requires the actual
mini artifacts (~/agents/corpus/runs/2026-07-25/<repo>.json), which are
not reachable from this machine, and a keyless local reproduction
produces the static output that matches 100% — there ARE no unmatched
annotations to sample locally. Whether each AI raise is over-caution or
a genuine label gap is enumerable only by diffing the mini's tools.json
risks against static extraction; prompt-tuning the enrichment toward
these repos is forbidden either way. Recommendation for the conductor:
have the next nightly upload (or retain) per-repo `.vendo/tools.json`
so raised-risk tools are diffable; if the raises are systematic
over-caution, that is a general enrichment-judgment question, not a
corpus one.

## Task 5: invoify background — expected #f1f5f9, got #ffffff (documented limitation)

Prior documentation: PR #450 listed this as the pre-documented
background expected-miss (init-ai-unification triage, 2026-07-20).
Source at pinned 93b21a22: the shadcn sheet `app/globals.css:7` declares
`--background: 0 0% 100%` (#ffffff) — the exact read is faithful to the
token. But the app paints its real page background with a UTILITY on a
nested locale layout: `app/[locale]/layout.tsx:90` `bg-slate-100`
(#f1f5f9), overriding the token it never uses. The label records the
rendered truth; the extractor records the declared token.

Does it generalize under task 4's rules? No general deterministic rule
survives its counter-examples: "body utility outranks the --background
token" requires scanning every nested layout for bg-* utilities
(invoify's is in a [locale] segment layout, not the root layout),
handling conditional/dark variants, and — decisively — it would
overturn the exact-read precedence law (exact reads are never
overwritten; pinned in applyThemeDraft semantics) on one repo's
evidence. Stays a documented limitation, recorded in
corpus/expectations/invoify/notes.md so the nightly reader stops
counting it as a surprise. The expected value was NOT edited — #f1f5f9
is the source-true rendered background.

---

# PARKED — video-system harness (lane: factory/video-harness)

## Round 2 (2026-07-26): P1 is RESOLVED, not parked

The round-1 park of the real overlay panel was rejected by the checker as
disguised weakening, and the checker was right. The real `VendoOverlay` panel,
its real header controls, the real `MessageList` transcript and the real
`.fl-barpin` "Pin to dashboard" control are all now mounted and on camera. See
`docs/verification/video-harness/README.md` §"The panel is real" for the
mechanism and the measured proof. P2 (Cadence's Next-coupled components) stands
below, unchanged and still the contract's own authorised branch — but the
settings surface it covers has been rebuilt from the host's real markup.

## Q1 — the orb whip now lands on nothing real. A design call for Yousef.

**Not a blocker.** The criterion ("zero hand-drawn agent-surface JSX") is met and
the pinned motion is untouched. This is a film-grammar question the code cannot
answer, recorded because the checker's instruction was that the header question
goes to Yousef rather than back into film grammar.

**The situation.** `OrbWhip.tsx` is CANON: the agent orb, having absorbed the
corpus, whips across frame and shrinks to a 6px violet dot at `DOT` — the
top-left of the chat panel — then hard-cuts at `DOT_HANDOFF`, where the
prototype's drawn "Assistant" header row took over with its violet status dot.

That header row was an invention. Evidence that the product has no counterpart:

    grep -o "\.fl-[a-z-]*\(dot\|blob\|avatar\)[a-z-]*" \
      packages/ui/src/chrome/chrome-css.ts | sort -u

Output — the only agent marks in the product are the launcher orb and the app
card's own dot; there is no panel-header dot and no panel title row at all:

    .fl-appcard-dot
    .fl-approvals-dot
    .fl-approvals-dot--on
    .fl-approvals-dots
    .fl-auto-runs-dot
    .fl-connect-done-dot
    .fl-glass-dot
    .fl-launcher-blob
    .fl-voice-blob
    .fl-voice-dots

`VendoOverlay`'s panel children, in source order, are: an `fl-sr-only` "Vendo"
label, the expand button, the new-conversation button, the close button, then
`.fl-split`. Its header IS that control cluster.

**What ships (the reversible default).** The invented row is deleted rather than
replaced, and the whip is left byte-identical: the orb condenses onto the real
panel's own top-left corner while the panel springs up beneath it, then hands
off. It reads as the orb becoming the panel. Frame 84 of the render
(`docs/verification/video-harness`) shows the landing.

**The three options, for whoever decides:**
1. Ship as-is — the orb dissolves into the panel's corner.
2. Land the whip on the product's REAL agent orb (`launcher={{label: null}}`
   renders `.fl-launcher-blob`, the blob-only orb) film-placed at `DOT`. Real
   pixels, but placed somewhere the product never puts it, and it is ~44px where
   the whip ends at 6px.
3. Give `VendoOverlay` a real title row in `packages/ui` — a product change, out
   of this lane's scope, and the only option that makes the shot true by
   construction.

Rejected outright: drawing a dot again.

## P2 — Cadence's own components are Next.js-coupled and cannot mount in Remotion

Contract task 3 says to import real `apps/demo-accounting` components "if
importable into the studio without hacks; else compose from packages/ui
primitives + the Cadence design tokens". This records which branch each
component landed on and why. Command:

    grep -rn "from \"next/" apps/demo-accounting/src/components/

Output:

    clients/client-table.tsx:4:   import Link from "next/link"
    clients/client-table.tsx:5:   import { useRouter, useSearchParams } from "next/navigation"
    clients/client-detail.tsx:3:  import Link from "next/link"
    shell/topbar.tsx:4:           import { useRouter } from "next/navigation"
    shell/sidebar.tsx:3:          import Link from "next/link"
    shell/sidebar.tsx:4:          import { usePathname } from "next/navigation"
    shell/app-shell.tsx:1:        import { headers } from "next/headers"
    vendo/VendoLayer.tsx:4:       import { usePathname, useRouter } from "next/navigation";
    dashboard/deadline-list.tsx:3:import Link from "next/link"

`app-shell.tsx` is additionally an async server component. Mounting these
would mean aliasing `next/link`, `next/navigation` and `next/headers` to
studio stubs — the "hacks" branch the contract rules out. A second blocker
is styling: Cadence is Tailwind v4 CSS-first with **no config file**
(`apps/demo-accounting/postcss.config.mjs` is the whole build), so every
one of these components is a bag of utility classes that resolve only
through Cadence's own PostCSS pipeline, which Remotion does not run. A
third: `stat-row`, `deadline-list`, `activity-feed`, `client-panel` are all
`useSWR` + relative `fetch`, so in the studio they would render their
skeletons forever — and the contract forbids network calls in compositions.

**Default taken (the contract's own "else" branch):**
- `MissingDocsHero` IS imported for real — it is pure React with inline
  styles and zero imports, so it mounts unchanged. See the import at
  `tools/video-studio/src/scenes/SceneProofC.tsx`.
- The rest of the console is composed from
  `tools/video-studio/src/cadence/tokens.ts`, which quotes Cadence's own
  `src/app/globals.css` `@theme` blocks and `.vendo/theme.json` verbatim —
  real tokens, not eyeballed values — plus the host's real nav labels, firm
  name, season and seeded client/activity copy.

Note the asymmetry with A2 deliberately: A2's "zero imitations" law is
scoped to the *agent surface* (task 2), where the contract demands real
components unconditionally and where they are used. Task 3 explicitly
authorises token-composition for host chrome.

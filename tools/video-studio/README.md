# video-studio

The Vendo video harness. Every "State of the art ___ in one click" film is an
**episode**: a config file of scenes and copy plugged into a shared template.

The thing that makes this a harness rather than a one-off render: the scenes
film the **real product**. The panel is `VendoOverlay`, the transcript is
`MessageList`, the bubbles, the `Sources` chips, the generated-app card and its
"Pin to dashboard" control are the actual `@vendoai/*` components from
`packages/`, mounted on the real provider and fed scripted state. The studio
authors no product markup at all — `grep -rn 'className="fl-' src` returns
nothing. When the product's UI changes, the video changes with it.

```
pnpm --filter video-studio render      # → out/one-click-knowledge.mp4
pnpm --filter video-studio preview     # Remotion Studio, for scrubbing
pnpm --filter video-studio test        # episode contract tests
```

`render` builds `@vendoai/ui`'s jail runtime first (a gitignored generated
file), so a clean checkout only needs `pnpm install`.

---

## Layout

```
src/
  episodes/            ← ONE FILE PER EPISODE. This is what you write.
    index.ts             the registry
    one-click-knowledge.tsx
  template/            ← the shared film. You should not need to touch this.
    Episode.tsx          renders an EpisodeSpec (sequences, shake, stage fit, audio)
    episode-spec.ts      the EpisodeSpec type + STAGE/stageFit + coverage checks
    OverlayPanel.tsx     the real VendoOverlay, film-positioned (read this first)
    onest.ts             the bundled brand typeface (no font CDN, ever)
    theme.ts             film grammar: brand colours, snap/push-in helpers
    vendo-theme.ts       the VendoTheme the real components are themed with
    VendoStage.tsx       the real provider + chrome boundary, wired offline
    Cursor.tsx           the branded pointer (path, press, ripple, trail)
    Detonation.tsx       the purple detonation
    OrbWhip.tsx          eruption → chat match cut
    WidgetFlight.tsx     chat → dashboard shared-element travel
    chatShared.ts        geometry the chat scene and the overlays agree on
  scenes/              ← reusable, copy-parameterised scenes
    agent-surface.tsx    builds the real UIMessage / UIPayload values
    SceneClick / SceneEruption / SceneChat / SceneProofC / SceneClaim / SceneOut
  cadence/tokens.ts    ← the host's real design tokens, quoted from its source
```

---

## Adding episode two (target: under 30 minutes)

1. **Copy an episode.** `cp src/episodes/one-click-knowledge.tsx
   src/episodes/one-click-<blank>.tsx`.

2. **Change the blank and the copy.** Everything episode-specific is at the top
   of the file as plain constants:

   - `BLANK` — the word that fills "State of the art ___ in one click".
   - `FEATURE` / `NEXT_FEATURE` — the host settings rows the cold open clicks.
     They render inside Cadence's real settings page (`src/cadence/settings.tsx`).
   - `CITATIONS` — the knowledge sources behind the answer. These are real
     `VendoKnowledgeCitation` values; the `Sources` chips are rendered from them
     by the product, never authored as chips.
   - The `askA` / `answer` / `askB` props on the chat scene.

3. **Pick scenes and beats.** The `scenes` array is `{id, component, from,
   durationInFrames}` in global frames. Scenes may overlap — that is how the
   dashboard mounts under the chat and gets revealed by the fade-back.

4. **Pick overlays.** `overlays` are the global-frame transitions that cross
   scene cuts. Take all three for a full film, or just `Detonation` for a short.

5. **Pick a resolution.** `width` / `height` on the spec are the real output
   resolution — the template fits the 1920x1080 authoring stage into whatever
   you declare, so a cheap proof render is `width: 854, height: 480` in the
   file, never a `--scale` flag on the command line. One caveat: the real
   overlay panel portals to `document.body` and is positioned in viewport
   pixels, so it does not ride the stage fit — episodes with a chat scene
   should stay at 1920x1080.

6. **Register it** in `src/episodes/index.ts`.

7. **Render it.** `pnpm --filter video-studio exec remotion render <Id>
   out/<name>.mp4`.

The tests in `src/template/episode-spec.test.ts` run over every registered
episode and will fail the build if your beats leave an uncovered frame (which
renders black) or run past the end of the episode.

### What NOT to do

- **Do not hand-draw product UI.** If a shot needs a thread, a message, an
  approval card or a generated view, mount the real component through
  `VendoStage` and `scenes/agent-surface.tsx`. A drawing of the product goes
  stale the day the product changes, which defeats the whole harness.
- **Do not redesign the motion.** The seven transition rules, the camera law
  and the detonation are the brand's film grammar. Episodes vary copy and
  beats, not motion.
- **Do not add wall-clock animation** (CSS transitions, `requestAnimationFrame`,
  `setTimeout`). Remotion renders frame by frame; anything on the wall clock
  makes renders non-reproducible. Drive everything from `useCurrentFrame()`.

---

## How the real components are filmed

Three decisions carry this, and they are worth knowing before you change
anything:

**The panel is the product's, positioned by the film.** `OverlayPanel.tsx`
mounts `<VendoOverlay open launcher="none" thread={ThreadSlot} />` and hands the
transcript in through the overlay's own documented eject seam (its `thread`
prop). The film contributes three things and nothing else: the pinned `CARD`
geometry (a scoped rule re-emitted every frame — the panel is `position: fixed`
and Remotion's viewport IS the film frame), one blanket rule that switches off
every wall-clock animation inside the chrome, and `FILM_Z`, which lifts the
film's own layers over the panel's `z-index: 2147483001`. If you need to move
the panel, change `CARD` in `chatShared.ts` — never restyle the component.

**Source imports, not `dist`.** `VendoOverlay`, `MessageList`, `ThreadMessage`
and `ensureChromeStyles` are not all in
`@vendoai/ui`'s public exports map, so the studio imports
`packages/ui/src/...` directly — the same thing `packages/ui/e2e/harness` does.
`remotion.config.ts` carries the one webpack override that makes it work
(`resolve.extensionAlias`, because that source uses ESM `.js` specifiers).

**Frame-driven props, not the streaming transport.** `ScriptedTransport` paces
on `setTimeout`, which Remotion cannot step. Instead the scenes compute the
exact `UIMessage` and `UIPayload` values a live turn would carry, as a function
of the frame, and the real components render them. The generated view really
does stream: `weeklyUsagePayload()` returns a growing tree with
`streaming: true`, which is what drives the app card's own
`building → ready` bar.

**The product's own motion is switched off.** `vendo-theme.ts` sets
`motion: "reduced"` (which zeroes `--vendo-motion-duration`), every turn is
rendered `restored` (suppressing the `.fl-item-in` CSS entrance), and
`OverlayPanel`'s `STILL_CSS` kills every remaining wall-clock animation and
transition inside the chrome's theme boundaries. All entrances come from the
film's `snap()` / `snapStyle()` instead, so the approved pacing is what plays.

**Typography is bundled.** `onest.ts` declares the brand face from
`public/fonts/*.woff2` — the same pinned bytes `packages/ui` ships inline — and
holds the render with `delayRender` until the glyphs are ready. No composition
may reach a font CDN, or any network at all.

## The host side

`SceneClick` and `SceneEruption` show Cadence's real settings page, replicated
markup-for-markup in `src/cadence/settings.tsx` — its `Row`, its 13px/12px
typography, its real `h-5 w-9` ink toggle, with each element carrying the host's
own class string beside the resolved token. The film reads it at a distance
because the scene's camera is zoomed in, exactly as a screen recording would be;
no value is inflated for the camera.

`SceneProofC` is the Cadence console. Its hero stat is the real
`MissingDocsHero` component imported from `apps/demo-accounting`; the rest of
the console is composed from `src/cadence/tokens.ts`, which quotes Cadence's
own `globals.css` and `.vendo/theme.json` verbatim. Nothing there is eyeballed.
Most of Cadence's other components are Next.js-coupled (`next/link`,
`next/headers`, `usePathname`) or SWR-driven, so they cannot mount in Remotion
without shimming the Next runtime — see `PARKED.md` at the repo root.

## Audio

`EpisodeSpec.audioSrc` is the soundtrack slot. Episodes render silent until a
track is supplied; the mix is a separate lane.

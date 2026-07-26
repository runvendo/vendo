# video-studio

The Vendo video harness. Every "State of the art ___ in one click" film is an
**episode**: a config file of scenes and copy plugged into a shared template.

The thing that makes this a harness rather than a one-off render: the scenes
film the **real product**. The chat transcript, the message bubbles, the
`Sources` citation chips and the generated-app card are the actual
`@vendoai/*` components from `packages/`, mounted on the real provider and fed
scripted state. When the product's UI changes, the video changes with it.

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
    Episode.tsx          renders an EpisodeSpec (sequences, shake, audio slot)
    episode-spec.ts      the EpisodeSpec type + coverage checks
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
   - `CITATIONS` — the knowledge sources behind the answer. These are real
     `VendoKnowledgeCitation` values; the `Sources` chips are rendered from them
     by the product, never authored as chips.
   - The `askA` / `answer` / `askB` props on the chat scene.

3. **Pick scenes and beats.** The `scenes` array is `{id, component, from,
   durationInFrames}` in global frames. Scenes may overlap — that is how the
   dashboard mounts under the chat and gets revealed by the fade-back.

4. **Pick overlays.** `overlays` are the global-frame transitions that cross
   scene cuts. Take all three for a full film, or just `Detonation` for a short.

5. **Register it** in `src/episodes/index.ts`.

6. **Render it.** `pnpm --filter video-studio exec remotion render <Id>
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

**Source imports, not `dist`.** `ThreadMessage`, `ThreadPart`,
`TurnCitations`, `ThreadAppCard` and `ensureChromeStyles` are not in
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
`motion: "reduced"` (which zeroes `--vendo-motion-duration`) and every turn is
rendered `restored`, which suppresses the `.fl-item-in` CSS entrance. All
entrances come from the film's `snap()` / `snapStyle()` instead, so the
approved pacing is what plays.

## The host side

`SceneProofC` is Cadence, the demo accounting host. Its hero stat is the real
`MissingDocsHero` component imported from `apps/demo-accounting`; the rest of
the console is composed from `src/cadence/tokens.ts`, which quotes Cadence's
own `globals.css` and `.vendo/theme.json` verbatim. Nothing there is eyeballed.
Most of Cadence's other components are Next.js-coupled (`next/link`,
`next/headers`, `usePathname`) or SWR-driven, so they cannot mount in Remotion
without shimming the Next runtime — see `PARKED.md` at the repo root.

## Audio

`EpisodeSpec.audioSrc` is the soundtrack slot. Episodes render silent until a
track is supplied; the mix is a separate lane.

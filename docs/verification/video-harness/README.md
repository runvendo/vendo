# Verification — video-system harness (`factory/video-harness`)

Evidence for the lane that moved the approved Remotion prototype into the repo
as `tools/video-studio/` and rewired its scenes onto the real `@vendoai/*`
components.

## Artefacts

| File | What it proves |
|---|---|
| `one-click-knowledge.mp4` | The episode. `1920x1080`, `30/1` fps, 420 frames, **14.058667 s** — inside the contracted 14 s ± 0.5 s. |
| `frames/t*.png` | The eight contract frames, extracted from that MP4 at 0.3 / 0.9 / 1.5 / 3.0 / 6.5 / 8.4 / 11.0 / 13.5 s. |
| `smoke-three-scene.mp4` | A second episode rendered from the same template with a different blank and different copy. |
| `smoke-three-scene.tsx` | The source of that episode — the whole of what "adding an episode" costs. |

### Reproducing

```bash
pnpm install
pnpm --filter video-studio render          # → tools/video-studio/out/one-click-knowledge.mp4
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,nb_frames \
  -show_entries format=duration -of default=nw=1 \
  tools/video-studio/out/one-click-knowledge.mp4
for t in 0.3 0.9 1.5 3.0 6.5 8.4 11.0 13.5; do
  ffmpeg -y -i tools/video-studio/out/one-click-knowledge.mp4 \
    -ss "$t" -frames:v 1 "frames/t${t}s.png"
done
```

`render` has a `prerender` hook that builds `@vendoai/ui`'s jail runtime
(`src/tree/jail/runtime-bundle.gen.ts` is gitignored and generated), so a clean
checkout needs nothing but `pnpm install`.

---

## Frame-by-frame

| t | Beat | What is on screen |
|---|---|---|
| 0.3 s | Cold open + detonation | The host settings row ("Knowledge" / "Give your agent your docs, schema, and data") with the three-layer violet detonation and the white shockwave ring mid-expansion. |
| 0.9 s | Detonation hold | Full violet flood, white vendo mark spring-snapped to screen centre. |
| 1.5 s | Eruption | The corpus storm — 34 file chips arcing into the agent orb, kinetic type "State-of-the-art" punching in, the settings toggle now on. |
| 3.0 s | Chat, proof A opening | **Real components.** The real user bubble (`.fl-turn-user`) mid-type inside the real `.fl-msglist`, plus the branded cursor with its motion trail. |
| 6.5 s | Chat, proof B building | **Real components.** The real in-thread app card (`.fl-appcard` + `.fl-appcard-bar` reading "Building your view…") with the real Kit `Stat` components already streamed in. |
| 8.4 s | Shared-element travel | The real app card in flight over the Cadence dashboard, mid-transition between the chat and its dashboard slot. |
| 11.0 s | Claim | "State-of-the-art knowledge base." |
| 13.5 s | End card | vendo wordmark. |

The 4.5 s frame (not in the contract list, captured during development) shows the
settled answer with the real `Sources` row: two real citation chips rendered by
`TurnCitations` from a `data-vendo-citations` part.

---

## Side-by-side: prototype vs real components

The prototype drew the product. The studio mounts it. Same beats, same frames,
different provenance.

| Surface | Prototype (`one-click-proto`) | Studio (`tools/video-studio`) |
|---|---|---|
| User message | Hand-written `Bubble` div: `borderRadius: '18px 18px 6px 18px'`, `backgroundColor: C.softFill` | `ThreadMessage` → `.fl-turn-user` → `UserText` → `.fl-usertext` |
| Assistant answer | Hand-written "AGENT" card with a violet dot and a `<div>` of text | `ThreadMessage` → `ThreadPart` → `Markdown` → `.fl-md` |
| Citation | Hand-drawn pill: `border: 1.5px solid C.violet`, `<DocIcon/>`, literal text `docs/auth.mdx §4` | `TurnCitations` → `.fl-cites` / `.fl-cites-label` ("Sources") / `CitationChip`, driven by a real `data-vendo-citations` part carrying `VendoKnowledgeCitation` values |
| Assembling widget | Hand-drawn card; title/stat/chart/pill each faded in by a local `snap()` | Real `ThreadAppCard`; the payload itself grows (`weeklyUsagePayload`) and carries `streaming: true`, which is what drives the component's own `data-state="building" → "ready"` bar |
| Widget contents | Hand-drawn stat boxes and a hand-authored SVG path | Real `PayloadView` → `TreeView` → Kit `Stat`, `LineChart` (recharts), `Badge` from a real `vendo-genui/v2` payload |
| Widget in flight | A second hand-drawn copy of the card, morphing two content specs | The same real card, rendered once and scaled along the path |
| Host dashboard | Invented cards, grey `Bar` placeholders, "acme" wordmark | Cadence: the real `MissingDocsHero` component, plus real tokens, real nav labels, real firm/season, real seeded client and activity copy |

### Traceability

Every real component the film mounts, as an import (`grep -rn` over
`tools/video-studio/src`):

```
template/VendoStage.tsx:2  import type {VendoClient} from '../../../../packages/ui/src/client';
template/VendoStage.tsx:3  import {VendoProvider} from '../../../../packages/ui/src/context';
template/VendoStage.tsx:7  } from '../../../../packages/ui/src/chrome/chrome-root';
scenes/agent-surface.tsx:4 import {ThreadMessage} from '../../../../packages/ui/src/chrome/thread/message';
scenes/SceneProofC.tsx:8   import {MissingDocsHero} from '../../../../apps/demo-accounting/src/components/dashboard/missing-docs-hero';
```

`ThreadMessage` is the whole agent surface: it fans out to `ThreadPart`,
`TurnCitations`, `Markdown`, `ThreadAppCard` and `PayloadView` inside
`packages/ui`.

The stronger check is the negative one — the studio never authors a product
class name. Counting `.fl-*` definitions in `packages/ui/src/chrome/chrome-css.ts`
against `className` authorship in `tools/video-studio/src`:

```
class              defined-in-packages/ui   authored-in-studio
fl-thread          3                        2
fl-msglist         10                       2
fl-turn-user       7                        0
fl-turn-assistant  8                        0
fl-cites           3                        0
fl-cite-btn        3                        0
fl-appcard         24                       0
fl-appcard-bar     8                        0
fl-uihost          2                        0
fl-usertext        1                        0
```

The studio names exactly two classes — `fl-thread` and `fl-msglist`, the list
containers it positions. Every message, citation chip and app-card class on
camera is emitted by the real components; there is no studio code that could
draw them.

No composition can reach the network: `VendoStage` passes a `VendoClient` whose
every method throws (`video-studio renders offline: refusing client.<x>.<y>()`),
and `ChromeRoot` is mounted with `automaticPolicyNotice={false}` so the
status probe never runs.

---

## Template proof (episode two)

`smoke-three-scene.tsx` is a three-scene episode with a different blank
("automations"), different copy, a different corpus and a different overlay set.
It was written from `tools/video-studio/README.md` and rendered without editing
a single file under `src/template/`.

```bash
# with the episode registered in src/episodes/index.ts
pnpm --filter video-studio exec remotion render SmokeThreeScene \
  out/smoke-three-scene.mp4 --scale=0.45
```

Result: `864x486`, 155 frames.

**Deviation, stated plainly:** the contract asks for 480p. 16:9 has no integer
resolution at exactly 480 lines (480 × 16/9 = 853.33), and h264 rejects odd
dimensions — `--scale=0.4444` produced `853x480` and ffmpeg failed with
`Error while opening encoder`. `--scale=0.45` gives `864x486`, the nearest
even-dimension 16:9 to 480p. The point of the criterion — that a new episode
renders from the template at a cheap resolution — holds.

Per the contract the smoke episode is kept as evidence rather than shipped, so
it is not registered in `src/episodes/index.ts` on the branch. To re-run it:
copy `smoke-three-scene.tsx` back into `tools/video-studio/src/episodes/`, add
`smokeThreeScene` to the `episodes` array, and run the command above. The
commit history on this branch has it registered and then removed, so
`git show --stat` over those two commits is the audit trail that adding an
episode touches `src/episodes/` only.

# Flowlet chat interface upgrade

## Overview

A polished upgrade to the `@flowlet/shell` chat surface across four areas: a
richer tool-activity display, assistant turn controls, composer attachments
(images + PDFs), and markdown polish. It also nails down the in-progress
choreography — what the surface looks like while the agent is thinking, running
tools, rendering UI, and streaming text.

Everything is built inside the existing `@flowlet/shell` package on top of the
Vercel AI SDK v6 (`ai@6.0.28`, `@ai-sdk/react@3.0.30`) already in use. No agent or
transport rewrite is required: the backend already converts attachment parts via
`convertToModelMessages` into the Anthropic model, and `regenerate` / file-part
sending are native SDK capabilities. This is a shell-only, host-agnostic change.

## First principles

1. **Show the consumer what's happening.** Tool activity is narrated in plain
   language, calm and legible, without burying the generated UI that is the hero
   of the surface.
2. **One live affordance at a time.** A turn shows a single "what's going on"
   signal — typing dots before anything arrives, or the activity panel once tools
   run — never competing indicators.
3. **Quiet by default, deep on demand.** Activity collapses to a one-line
   summary; turn controls appear on hover; attachment detail is compact. The user
   can always expand for the full picture.
4. **Reuse the SDK, don't reinvent it.** Regenerate, file parts, and tool-part
   state machines come from the AI SDK as-is.
5. **Host-agnostic.** No demo-specific content. Feedback is surfaced through a
   callback seam the host wires; the shell builds no feedback backend.

## Scope

In scope:
- Tool-activity panel (replaces per-tool chips).
- Turn controls: copy, regenerate, thumbs up/down, retry-on-error, hover
  timestamp.
- Composer attachments: images + PDFs via button, paste, drag-drop.
- Markdown polish: styled GFM tables, KaTeX math, timestamps.
- In-progress choreography for thinking, tools, UI rendering, and text streaming.

Out of scope (this pass):
- Edit-and-resend / conversation branching.
- Syntax highlighting for code blocks.
- Resumable streams, sources/citations, reasoning parts.
- Any server-side feedback store.

## Components and seams

New components in `packages/flowlet-shell/src/components/`:

- **ActivityPanel** — one collapsible panel per assistant turn that aggregates
  that turn's tool calls. Owns collapsed/expanded state, header text, and the
  step list with result peeks.
- **ActivityStep** — a single tool row inside the panel: status icon, humanized
  label, short result summary, and an optional compact result-peek table.
- **TurnActions** — the hover control row under an assistant turn (copy,
  regenerate, thumbs up/down) plus the timestamp.
- **AttachmentChips** — the preview row above the composer input: image
  thumbnails and PDF file chips, each removable.
- **AttachmentDropZone** — the drag-over overlay indicating a droppable area.

New hook:

- **useAttachments** — holds pending attachments for the composer, handles add
  (button / paste / drop), type + size + count validation, object-URL lifecycle,
  removal, and conversion to SDK file parts on send.

Changed units:

- **MessageList** — groups a turn's consecutive tool parts into a single
  ActivityPanel instead of rendering individual `ToolCall` chips; keeps the
  render-skeleton and data-ui handling; hosts TurnActions per assistant turn.
- **Composer** — gains the attach button, paste and drag-drop handling, the
  attachment preview row, and sends text + file parts together.
- **StreamingText** — adds `remark-math` + `rehype-katex`, table styling hooks,
  and the word-fade-in reveal.
- **use-flowlet-thread** — the `ThreadItem` model extends so tool items carry the
  input/output needed for result peeks, the skeleton item carries the streaming
  component `name` (for shape-matched skeletons), and each turn exposes a stable
  timestamp.
- **FlowletThread** — threads a new optional `onFeedback` prop to TurnActions.

New dependencies (`@flowlet/shell`): `remark-math`, `rehype-katex`, `katex`.

## Feature detail

### Tool-activity panel

- One `ActivityPanel` per assistant turn aggregates that turn's tool calls.
  `render_ui` is excluded — it is represented by its skeleton and resulting
  `data-ui` card, as today.
- **Collapsed by default**, including while working. The header reads
  `● Working (current step…)`, where the parenthetical is the label of the
  active step and updates as steps advance.
- On completion it settles to a summary that leads with the last action, e.g.
  `✓ Posted to Slack · +2 more`. When only one tool ran, the `· +N more` suffix
  is omitted.
- Expanding reveals the ordered step list. A step whose tool produced structured
  output shows a compact result-peek (a small two-column table); steps without
  peekable output show just the row and a short summary.
- Errors surface on the offending step (error styling) and are reflected in the
  header summary.

### Turn controls

- A quiet icon row under each assistant turn: **Copy** (copies the turn's raw
  markdown text), **Regenerate** (calls the SDK `regenerate()` for that turn),
  **thumbs up / down** (toggle; invokes the optional `onFeedback` callback with
  the turn id and the vote — no backend built here).
- Visible on hover; always visible on the most recent assistant turn.
- On an errored turn, **Retry** replaces Regenerate.
- A subtle timestamp sits at the end of the row, fading in on hover.

### Composer attachments (images + PDFs)

- Accepts images (`png`, `jpeg`, `gif`, `webp`) and `pdf` via an attach button,
  clipboard paste, and drag-drop. A drop-zone overlay appears on drag-over.
- Client-side validation for file type, per-file size, and total count; rejected
  files produce a brief inline message and are not attached.
- Previews render above the input: images as thumbnails, PDFs as a file chip with
  name and size. Each preview is removable before sending.
- On send, attachments are converted to SDK file parts and sent alongside the
  text via `sendMessage`. The user turn renders the attachments (thumbnails /
  file chip) above its text.
- The backend already accepts these parts through `convertToModelMessages`, so no
  server change is required; the model is Anthropic, which reads images and PDFs.

### Markdown polish

- **Tables**: GFM tables gain borders, an uppercase muted header row, and zebra
  striping via CSS.
- **Math**: `remark-math` + `rehype-katex` render inline and block LaTeX; KaTeX
  CSS is bundled with the shell styles.
- **Timestamps**: a per-turn timestamp, shown on hover, shared with the turn
  control row.

## In-progress choreography

The life of a turn:

1. **Sent → waiting.** The user turn renders immediately. Until the first content
   arrives, a minimal three-dot typing indicator shows. (Text-only turns keep
   this indicator; the activity panel is not shown when no tool fires.)
2. **A tool fires.** The three-dot indicator is replaced by the ActivityPanel,
   collapsed, header `● Working (first step…)`. The parenthetical updates per
   step as tools run.
3. **Rendering a view.** When `render_ui` is in flight, a **shape-matched
   skeleton** holds the card's place: the streaming tool input exposes the
   component `name` early, which maps to a skeleton archetype (chart / table /
   list / stat), falling back to a generic shimmer when the name is missing or
   unmapped. The activity header reads `(building your view…)`.
4. **Content lands.** The skeleton swaps to the real `data-ui` card with a soft
   rise-in. Assistant text streams below with a trailing caret and a subtle
   word-fade-in as each chunk arrives.
5. **Settled.** The panel collapses to its last-action summary; the turn control
   row fades in under the assistant text.

`prefers-reduced-motion` disables the rise-in, word-fade-in, and shimmer,
matching the existing reduced-motion handling.

## Data flow

- `useFlowletChat` (SDK `useChat`) remains the source of messages; the transport
  is unchanged. `regenerate` and `sendMessage` (with file parts) are called
  through the existing hook surface.
- `toThreadItems` continues to normalize message parts into render items, now
  preserving tool input/output for peeks and the streaming component name for the
  skeleton, and stamping a per-turn timestamp.
- Feedback and copy are pure client actions; feedback is forwarded to the host
  through `onFeedback` and is otherwise a no-op.

## Error handling

- Tool errors render on the relevant ActivityStep and in the panel summary;
  the existing single-error-surface rule (no duplicate banner when the last item
  is an inline error) is preserved.
- Errored assistant turns show **Retry** in place of Regenerate.
- Attachment validation failures show a brief inline composer message; they never
  block sending the remaining valid attachments or text.
- The existing `ThreadErrorBoundary` continues to wrap the transcript.

## Testing

Unit tests (vitest + Testing Library, following existing patterns in
`packages/flowlet-shell/src/components/*.test.tsx`):

- ActivityPanel: collapsed-by-default, header parenthetical reflects the active
  step, done summary leads with the last action and pluralizes `+N more`, expand
  reveals steps, a step with output renders a peek, error state surfaces.
- TurnActions: copy writes the turn markdown, regenerate calls the SDK,
  thumbs toggle and invoke `onFeedback`, retry appears on errored turns.
- useAttachments / AttachmentChips: add via each path, type/size/count
  validation, removal, conversion to file parts.
- StreamingText: GFM table renders with styling hooks, inline and block math
  render, raw HTML stays escaped, streaming caret behavior preserved.
- Skeleton shape mapping: known names map to their archetype, unknown falls back
  to shimmer.

Visual verification: render the upgraded surface in `apps/demo-bank` and
screenshot the key states (waiting, tools running, rendering, streaming, settled,
composer with attachments) to confirm the choreography.

## Risks and mitigations

- **Streaming tool input may arrive whole for small inputs**, so the component
  name might land at `input-available` rather than incrementally. Mitigation: the
  skeleton is shown across both `input-streaming` and `input-available`, so the
  name is available in time; the generic shimmer is the fallback either way.
- **KaTeX CSS size.** Bundled with shell styles; acceptable for the surface.
- **Feedback has no sink by default.** Intentional — the shell exposes the seam;
  wiring is the host's responsibility.

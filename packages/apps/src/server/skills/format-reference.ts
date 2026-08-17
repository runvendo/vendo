/**
 * `references/format.md` — the `building-apps` skill's companion file: how to
 * write the screen. A FILE on the `/host` mount, read with the harness's own
 * hands, never listed.
 *
 * A screen is a plain React component now, so this file teaches only the DELTAS
 * from React a model already knows: the two imports, catalog-only components, a
 * write as one element, tool calls in handlers, no clock and no network, keys,
 * controlled inputs. Everything that used to live here — a markup dialect, its
 * attribute forms, its brace grammar, its island envelope — is gone with the
 * dialect, and teaching it would send a model writing a file nothing compiles.
 *
 * The component half is INTERPOLATED from the same generated schemas the engine's
 * workers read (`componentsPromptSection`), so it cannot drift from the code — and
 * it now teaches the same idiom this chapter does, so nothing here has to correct
 * it (`contract/kit/kit-prompt.ts`).
 */
import { DISPLAY_TAG_NAMES } from "../../contract/kit/index.js";
import { SCREEN_FILE } from "../../contract/genui/component/index.js";
import { VENDO_THEME_VARIABLE_NAMES } from "../../contract/theme.js";
import { HOT_PATH_FILES } from "../generation/render-seam.js";
import { componentsPromptSection } from "../generation/contracts/sections.js";

/** The file a harness with hands saves — the screen artifact's own name, held here
 *  to the list of files the seam WATCHES, because this is the one place both are in
 *  scope. A manual that names a basename the seam does not watch teaches a save
 *  that paints nothing, on the one leg that writes files itself (`claudeCode()`). */
const APP_FILE: (typeof HOT_PATH_FILES)[number] = SCREEN_FILE;

const CHAPTER = `# The screen file

An app is ONE file — \`${APP_FILE}\`, in the app's own directory
\`user/apps/app_<name>/\` — holding a React component, default-exported. Saving it
repaints the person's screen.

\`\`\`tsx
import { useState } from "react";
import { useQuery, tools, Stack, Text, Button } from "@vendo/screen";

export default function Overview() { … }
\`\`\`

Those two imports are everything there is. Nothing else can be loaded.

**Data — \`useQuery("tool_name")\`.** Synchronous, and it hands back the tool's
result exactly as the tool returns it, so read the field names off the tool's own
schema. Money arrives in whatever unit that schema says: divide a \`_cents\` field
by 100 where you read it, because the components format and never convert.

**Actions — \`tools.<tool_name>(args)\`, inside an event handler only.** Never
during render. \`await\` it when you need the result; the host runs the tool and
answers. When an awaited call succeeds, every \`useQuery\` on the screen re-runs
and the screen re-renders with fresh data on its own — so never patch state to
mirror what the refresh will bring back. Destructive and money-moving calls are
confirmed by the product OUTSIDE your screen — the guard asks the person before
the call runs — so never build a confirm step of your own: no "are you sure"
panel, no second button, no \`confirming\` state. The exception is a confirmation
the person ASKED for, or one press that fires a whole batch of calls: that one is
part of their app, and it is a \`<Modal>\` saying how many, with the button that
runs the loop LAST in its \`footer\` — that footer is a right-aligned row, so the
last button is the one a person reaches for. A guarded host still asks once per
call on top of it, and that is the trade: only your Modal can say how many, and
being asked twice beats a batch that goes out silently.

**Components — the catalog below, and nothing else.** Every component already
carries this product's own theme, so anything with behavior — a table, a number,
a date, a control — is a component, never HTML you assemble yourself. That holds
inside a sentence too: an amount in prose is an inline \`<Money>\`, never a \`$\`
and a \`toFixed\` you typed, which lose the grouping and the host's own currency.

**Layout — the display tags, plus \`style\`.** \`${DISPLAY_TAG_NAMES.join("`, `")}\`
are yours to arrange with, and they take children and an inline \`style\` and
nothing else: no \`className\`, no \`id\`, no handlers. Style them off the host's own
CSS variables (\`var(--vendo-color-accent)\`, \`var(--vendo-density-content-gap)\`)
so the screen stays branded — a hard-coded color is your color, not the
product's; every variable there is, and what each one means, is listed at the end
of this file. There is no network in here, so a style that fetches (\`url(…)\`) is
dropped.
\`key={…}\` on every row you \`.map\`. Dates go to the date
component as the ISO string you were given — there is no clock in here, so no
\`new Date()\`; and no \`fetch\`, \`localStorage\` or \`setTimeout\` either, because
there is no network, no storage and no timers.

**State — \`useState\`.** Inputs are controlled: \`value={x}\` with
\`onChange={(e) => setX(e.target.value)}\`. A handler receives a plain
\`{ target: { value } }\` — a checkbox, \`{ target: { checked } }\` — and there is no
\`preventDefault\` to call: \`<Form>\` submits itself.

Save errors tell you exactly what to fix. Fix and save again.

---

## One worked screen, end to end

The ask: "let me cancel a transfer before it goes out."

\`\`\`tsx
import { Button, Card, DateTime, Money, Row, Stack, Text, tools, useQuery } from "@vendo/screen";

export default function PendingTransfers() {
  const pending = useQuery("list_pending_transfers");

  return (
    <Stack gap={12}>
      <Text text="Transfers waiting to go out" variant="heading" />

      {pending.data.length === 0 ? (
        <Text text="Nothing is waiting to go out." variant="caption" />
      ) : (
        pending.data.map((transfer) => (
          <Card key={transfer.id} title={transfer.recipient}>
            <Row justify="between" align="center">
              <Stack gap={4}>
                <Money amount={transfer.amount_cents / 100} />
                <DateTime value={transfer.scheduled_for} mode="date" />
              </Stack>
              <Button label="Cancel" variant="danger" onClick={() => tools.cancel_transfer({ id: transfer.id })} />
            </Row>
          </Card>
        ))
      )}
    </Stack>
  );
}
\`\`\`

Nothing on that screen is typed in: every value is read off the query, every
number and date is formatted by the component showing it, the empty list says so
in one honest line, and the one thing that changes the product files its call
straight from the press — the product does the asking.

---

## Components

Host components come first when one fits: they are this product's own, already
branded. Every one of them is named in this product's own brief; open
\`host/components/<Name>.md\`, relative to the directory you are working in, for
its full props schema and examples.

Everything below ships with the format and is available in every screen. The prop
names and types are exact — an unknown prop fails the checks.

`;

/**
 * What each variable is FOR, one short line each — never what it is SET to: the
 * values are this host's and per-theme, and the briefing pack carries them.
 *
 * Only the MEANINGS live here. The names the section prints are walked off
 * `VENDO_THEME_VARIABLE_NAMES`, which is read off `themeCssVariables` itself, so
 * a variable added or renamed reaches the manual the day it is emitted and a
 * meaning left behind fails the drift test instead of teaching a dead name.
 */
const VARIABLE_MEANINGS: Record<string, string> = {
  "--vendo-color-success": "a completed or positive state",
  "--vendo-color-warning": "something that needs attention, not yet wrong",
  "--vendo-color-surface-raised": "a panel resting on a surface",
  "--vendo-color-background": "the page behind everything",
  "--vendo-color-surface": "a panel resting on the page",
  "--vendo-color-text": "body text",
  "--vendo-color-muted": "secondary text and labels",
  "--vendo-color-accent": "the brand color — the primary action",
  "--vendo-color-accent-text": "text and icons sitting on the accent",
  "--vendo-color-danger": "destructive and error",
  "--vendo-color-border": "hairlines, outlines and dividers",
  "--vendo-color-scheme": "`light` or `dark`, derived from the background",
  "--vendo-font-family": "the body text face",
  "--vendo-heading-family": "the heading face — set only when this host has one",
  "--vendo-mono-family": "the monospace face, for code and figures",
  "--vendo-font-size": "the body text size",
  "--vendo-base-size": "that same size, as the anchor the type scale derives from",
  "--vendo-font-weight-normal": "the body weight",
  "--vendo-font-weight-emphasis": "the weight for emphasis and headings",
  "--vendo-letter-spacing": "the body tracking",
  "--vendo-line-height": "the body leading",
  "--vendo-line-height-heading": "the tighter leading a heading takes",
  "--vendo-radius-small": "the corner radius of a control or badge",
  "--vendo-radius-medium": "the corner radius of a card or input",
  "--vendo-radius-large": "the corner radius of a panel or sheet",
  "--vendo-shadow-small": "the hover lift",
  "--vendo-shadow-medium": "anything resting above a surface",
  "--vendo-shadow-large": "an overlay floating over the page",
  "--vendo-border-width": "the hairline thickness",
  "--vendo-chart-1": "the first chart series color — the accent itself",
  "--vendo-chart-2": "the second chart series color",
  "--vendo-chart-3": "the third chart series color",
  "--vendo-chart-4": "the fourth chart series color",
  "--vendo-chart-5": "the fifth chart series color",
  "--vendo-chart-6": "the sixth chart series color",
  "--vendo-density": "`comfortable` or `compact` — which spacing scale is in force",
  "--vendo-density-control-height": "the height of a button or input",
  "--vendo-density-control-padding": "the padding inside a button or input",
  "--vendo-density-card-padding": "the padding inside a card",
  "--vendo-density-content-gap": "the gap between blocks stacked in a column",
  "--vendo-density-inline-gap": "the gap between items sitting in a row",
  "--vendo-density-field-gap": "the gap between a label and its field",
  "--vendo-density-table-padding": "the padding inside a table cell",
  "--vendo-density-badge-height": "the height of a badge",
  "--vendo-density-badge-padding": "the padding inside a badge",
  "--vendo-density-stat-padding": "the padding inside a stat",
  "--vendo-density-tabs-padding": "the padding around a tab strip",
  "--vendo-density-tab-height": "the height of one tab",
  "--vendo-density-tab-padding": "the padding inside one tab",
  "--vendo-motion": "`full` or `reduced`",
  "--vendo-motion-duration": "one transition's duration — `0ms` when motion is reduced",
  "--vendo-motion-easing": "the easing curve a transition uses",
};

/** The VARIABLES section, generated the way the catalog is. */
const variablesPromptSection = (): string => `---

# The host's CSS variables

Every one of these is already set on your screen, at this product's own values.
Use the NAME — the values are in the brief, and a copied value stops being the
product's the moment its theme changes. A name outside this list resolves to
nothing and the declaration it was in silently falls back.

${VENDO_THEME_VARIABLE_NAMES.map((name) => `\`${name}\` — ${VARIABLE_MEANINGS[name]}`).join("\n")}
`;

/** The reference as it lands on disk. */
export const VENDO_FORMAT_REFERENCE = `${CHAPTER}${componentsPromptSection()}\n\n${variablesPromptSection()}`;

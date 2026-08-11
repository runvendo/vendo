/**
 * `references/format.md` — the `building-apps` skill's companion file: how to
 * write the screen. A FILE on the `/host` mount, read with the harness's own
 * hands, never listed.
 *
 * A screen is a plain React component now, so this file teaches only the DELTAS
 * from React a model already knows: the two imports, catalog-only components, tool
 * calls in handlers, no clock and no network, keys, controlled inputs. Everything
 * that used to live here — a markup dialect, its attribute forms, its brace
 * grammar, its island envelope — is gone with the dialect, and teaching it would
 * send a model writing a file nothing compiles.
 *
 * The component half is INTERPOLATED from the same generated schemas the engine's
 * workers read (`componentsPromptSection`), so it cannot drift from the code — and
 * it now teaches the same idiom this chapter does, so nothing here has to correct
 * it (`contract/kit/kit-prompt.ts`).
 */
import { SCREEN_FILE } from "../../contract/genui/component/index.js";
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
answers. When an awaited call succeeds, every \`useQuery\` on the screen re-runs and
the screen re-renders with fresh data on its own — so never patch state to mirror
what the refresh will bring back. The host may also put its own approval card in
front of a destructive call; that is its business, and you still write the call.

**Components — the catalog below, and nothing else.** No \`<div>\`, no
\`className\`, no \`style\`, no CSS: each component already carries this product's
own theme, so a screen built out of them is branded and a screen you style
yourself is wrong. \`key={…}\` on every row you \`.map\`. Dates go to the date
component as the ISO string you were given — there is no clock in here, so no
\`new Date()\`; and no \`fetch\`, \`localStorage\` or \`setTimeout\` either, because
there is no network, no storage and no timers.

**State — \`useState\`.** Inputs are controlled: \`value={x}\` with
\`onChange={(e) => setX(e.target.value)}\`. A handler receives a plain
\`{ target: { value } }\` — a checkbox, \`{ target: { checked } }\` — and there is no
\`preventDefault\` to call: \`<Form>\` submits itself. Confirm a destructive action
wherever the flow needs confirming.

Save errors tell you exactly what to fix. Fix and save again.

---

## One worked screen, end to end

The ask: "let me cancel a transfer before it goes out."

\`\`\`tsx
import { useState } from "react";
import { Button, Callout, Card, DateTime, Money, Row, Stack, Text, tools, useQuery } from "@vendo/screen";

export default function PendingTransfers() {
  const pending = useQuery("list_pending_transfers");
  const [confirming, setConfirming] = useState<string | null>(null);

  const cancel = async (id: string) => {
    await tools.cancel_transfer({ id });
    setConfirming(null);
  };

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
              <Button label="Cancel" variant="secondary" onClick={() => setConfirming(transfer.id)} />
            </Row>

            {confirming === transfer.id && (
              <Callout tone="warning" title="Cancel this transfer?">
                <Row gap={8}>
                  <Button label="Yes, cancel it" variant="danger" onClick={() => cancel(transfer.id)} />
                  <Button label="Keep it" variant="secondary" onClick={() => setConfirming(null)} />
                </Row>
              </Callout>
            )}
          </Card>
        ))
      )}
    </Stack>
  );
}
\`\`\`

Nothing on that screen is typed in: every value is read off the query, every
number and date is formatted by the component showing it, the empty list says so
in one honest line, and the one thing that changes the product goes through
\`tools.cancel_transfer\` in a handler.

---

## Components

Host components come first when one fits: they are this product's own, already
branded. One file each, with the full props schema and examples:
\`host/components/<Name>.md\`, relative to the directory you are working in.
\`search_components\` finds one by intent when you do not know the name.

Everything below ships with the format and is available in every screen. The prop
names and types are exact — an unknown prop fails the checks.

`;

/** The reference as it lands on disk. */
export const VENDO_FORMAT_REFERENCE = `${CHAPTER}${componentsPromptSection()}\n`;

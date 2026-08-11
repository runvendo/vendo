/** J3 — APP EDIT + HISTORY through the composed wire.
 *
 * Create an app (POST /apps — the screen agent saves the whole `app.tsx` screen
 * with its own hands), then edit it (POST /apps/:id/edit — the SAME loop, asked
 * to rewrite that app's screen, answering with another whole-file `save_app`).
 * Both saves land through the real render seam, the real component gauntlet and
 * `AppsRuntime.authoredScreen`. The wire returns an EditResult; history surfaces
 * the prior version.
 *
 * A component screen keeps NO tree on its document — a screen's tree is what
 * running it produces — so what the person sees is read back off a real render
 * (`GET /apps/:id/open` re-runs the stored screen in the sealed VM).
 *
 * History note: the frozen history surface (06 §1) lists prior snapshots,
 * appended only on edit — so one edit yields exactly one entry (the original).
 */
import { SCREEN_FILE } from "@vendoai/apps";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADA,
  createStack,
  resetFixture,
  screenAgentCreateTurns,
  type Stack,
} from "../src/harness.js";

interface TreeNode {
  id: string;
  component: string;
  props?: { text?: string };
}
interface AppDoc {
  id: string;
  source?: Record<string, { text?: string }>;
}

/** The screen, and the same screen with the greeting changed. There is no quoted
 *  old/new pair and no edit-in-place tool here — a screen edit IS the app's own
 *  file saved back, which is the only write path there is. */
const screenSaying = (greeting: string): string => `import { Disclaimer, Stack, Text } from "@vendo/screen";

export default function Greeting() {
  return (
    <Stack gap={12}>
      <Text text="${greeting}" variant="heading" />
      <Disclaimer reason="Fixture app." />
    </Stack>
  );
}
`;

const CREATE_SCREEN = screenSaying("Hello");
const EDIT_SCREEN = screenSaying("Goodbye");

/** The screen text as the app STORES it — the source the save landed. */
const storedGreeting = (doc: AppDoc): string | undefined => doc.source?.[SCREEN_FILE]?.text;

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

describe("J3: app edit + history through the composed wire", () => {
  /** What the person's screen really shows: the stored `app.tsx`, RENDERED — the
   *  wire's own open path, which re-runs it in the sealed VM. */
  const paintedGreeting = async (appId: string): Promise<string | undefined> => {
    const opened = (await (await stack.wireFetch(`/apps/${appId}/open`, {}, ADA)).json()) as {
      payload: { nodes: TreeNode[] };
    };
    return opened.payload.nodes.find((node) => node.component === "Text")?.props?.text;
  };

  it("creates, edits by saving the app's own screen back, and lists the prior version", async () => {
    await resetFixture();
    stack = await createStack({
      turns: [
        ...screenAgentCreateTurns(CREATE_SCREEN),
        ...screenAgentCreateTurns(EDIT_SCREEN),
      ],
    });

    // --- Create -----------------------------------------------------------
    const created = (await (await stack.wireFetch("/apps", {
      method: "POST",
      body: JSON.stringify({ prompt: "Build a greeting card" }),
    }, ADA)).json()) as AppDoc;
    const appId = created.id;
    expect(storedGreeting(created)).toBe(CREATE_SCREEN);
    expect(await paintedGreeting(appId)).toBe("Hello");
    expect(await stack.sql("SELECT id FROM vendo_apps WHERE subject = $1", [ADA.subject])).toHaveLength(1);

    // --- Edit ---------------------------------------------------------------
    const edited = (await (await stack.wireFetch(`/apps/${appId}/edit`, {
      method: "POST",
      body: JSON.stringify({ instruction: "Change the greeting text to Goodbye" }),
    }, ADA)).json()) as { app: AppDoc; version: { rung: number } };
    expect(edited.version.rung).toBe(1);
    // IN PLACE: the same app, not a second one.
    expect(edited.app.id).toBe(appId);
    expect(storedGreeting(edited.app)).toBe(EDIT_SCREEN);

    // Current app now reads the edited text — stored, and on screen.
    const current = (await (await stack.wireFetch(`/apps/${appId}`, {}, ADA)).json()) as AppDoc;
    expect(storedGreeting(current)).toBe(EDIT_SCREEN);
    expect(await paintedGreeting(appId)).toBe("Goodbye");

    // --- History lists the prior version ----------------------------------
    const history = (await (await stack.wireFetch(`/apps/${appId}/history`, {}, ADA)).json()) as Array<{
      rung: number;
      intent: string;
    }>;
    expect(history).toHaveLength(1);
    // The version is filed under the PERSON's words, not "Saved app.vendo":
    // an edit lands through `authored` like any other commit, and the intent is
    // what makes the trail replayable.
    expect(history[0]?.intent).toBe("Change the greeting text to Goodbye");

    // The recorded snapshot is the pre-edit document.
    expect(history[0]?.rung).toBe(1);
  });
});

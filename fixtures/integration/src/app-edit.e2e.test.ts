/** J3 — APP EDIT + HISTORY through the composed wire.
 *
 * Create an app (POST /apps — the screen agent saves the whole `<App …>`
 * document with its own hands), then edit it (POST /apps/:id/edit — the SAME
 * loop, asked to rewrite that app's document, answering with another whole-
 * document `save_app`). Both saves land through the real render seam and
 * `AppsRuntime.authored`. The wire returns an EditResult; history surfaces the
 * prior version.
 *
 * History note: the frozen history surface (06 §1) lists prior snapshots,
 * appended only on edit — so one edit yields exactly one entry (the original).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ADA,
  createStack,
  resetFixture,
  screenAgentCreateTurns,
  type Stack,
} from "./harness.js";

interface TreeNode {
  id: string;
  props?: { text?: string };
}
interface AppDoc {
  id: string;
  tree: { nodes: TreeNode[] };
}

const CREATE_DIALECT = '<App name="Greeting"><Text text="Hello"/><Disclaimer reason="Fixture app."/></App>';

// The edit answer: the whole document again, with the greeting changed. There is
// no quoted old/new pair and no edit-in-place tool — a screen edit IS the app's
// own document saved back, which is the only write path there is. Identity is
// carried by the document's own shape, so the greeting node keeps the id the
// screen already mounted.
const EDIT_DIALECT = '<App name="Greeting"><Text text="Goodbye"/><Disclaimer reason="Fixture app."/></App>';

const greetingText = (doc: AppDoc): string | undefined =>
  doc.tree.nodes.find((node) => node.id === "text-1")?.props?.text;

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

describe("J3: app edit + history through the composed wire", () => {
  it("creates, edits by saving the app's own document back, and lists the prior version", async () => {
    await resetFixture();
    stack = await createStack({
      turns: [
        ...screenAgentCreateTurns(CREATE_DIALECT),
        ...screenAgentCreateTurns(EDIT_DIALECT),
      ],
    });

    // --- Create -----------------------------------------------------------
    const created = (await (await stack.wireFetch("/apps", {
      method: "POST",
      body: JSON.stringify({ prompt: "Build a greeting card" }),
    }, ADA)).json()) as AppDoc;
    const appId = created.id;
    expect(greetingText(created)).toBe("Hello");
    expect(await stack.sql("SELECT id FROM vendo_apps WHERE subject = $1", [ADA.subject])).toHaveLength(1);

    // --- Edit ---------------------------------------------------------------
    const edited = (await (await stack.wireFetch(`/apps/${appId}/edit`, {
      method: "POST",
      body: JSON.stringify({ instruction: "Change the greeting text to Goodbye" }),
    }, ADA)).json()) as { app: AppDoc; version: { rung: number } };
    expect(edited.version.rung).toBe(1);
    // IN PLACE: the same app, not a second one.
    expect(edited.app.id).toBe(appId);
    expect(greetingText(edited.app)).toBe("Goodbye");

    // Current app now reads the edited text.
    const current = (await (await stack.wireFetch(`/apps/${appId}`, {}, ADA)).json()) as AppDoc;
    expect(greetingText(current)).toBe("Goodbye");

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

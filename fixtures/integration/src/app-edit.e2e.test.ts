/** J3 — APP EDIT + HISTORY through the composed wire.
 *
 * Create an app (POST /apps — a tiny ask, so the brain writes the whole app on
 * the spot), then edit it (POST /apps/:id/edit — the brain quotes the app's own
 * printed text and says what replaces it, which the composed engine applies and
 * re-validates). The wire returns an EditResult; history surfaces the prior
 * version; undo restores it.
 *
 * History note: the frozen history surface (06 §1) lists RESTORABLE prior
 * snapshots (the undo targets), appended only on edit — so one edit yields
 * exactly one entry (the original), and a single undo restores the original.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ADA,
  createStack,
  generationTurn,
  resetFixture,
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

// The small-change answer: the exact text as the app prints it (a bare-text
// <Text> node prints as its own text) and what replaces it. Identity carries by
// edit span, so the greeting node keeps the id the screen already mounted.
const EDIT_DIALECT = '<Edit><Old>Hello</Old><New>Goodbye</New></Edit>';

// The AI reviewer rides the same scripted model once per landed document. It is
// asked for a strict `report_findings` tool call, so prose is how a reviewer with
// nothing to say says it.
const REVIEW_SILENT = "Nothing to report.";

const greetingText = (doc: AppDoc): string | undefined =>
  doc.tree.nodes.find((node) => node.id === "text-1")?.props?.text;

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

describe("J3: app edit + history through the composed wire", () => {
  it("creates, edits by quoting the app's own text, lists the prior version, and undoes to restore it", async () => {
    await resetFixture();
    stack = await createStack({
      turns: [
        generationTurn(CREATE_DIALECT),
        generationTurn(REVIEW_SILENT, "review_1"),
        generationTurn(EDIT_DIALECT, "gen_2"),
        generationTurn(REVIEW_SILENT, "review_2"),
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
    expect(greetingText(edited.app)).toBe("Goodbye");

    // Current app now reads the edited text.
    const current = (await (await stack.wireFetch(`/apps/${appId}`, {}, ADA)).json()) as AppDoc;
    expect(greetingText(current)).toBe("Goodbye");

    // --- History lists the restorable prior version -----------------------
    const history = (await (await stack.wireFetch(`/apps/${appId}/history`, {}, ADA)).json()) as Array<{
      rung: number;
      intent: string;
    }>;
    expect(history).toHaveLength(1);

    // --- Undo restores the original ---------------------------------------
    const restored = (await (await stack.wireFetch(`/apps/${appId}/history`, {
      method: "POST",
      body: JSON.stringify({ op: "undo" }),
    }, ADA)).json()) as AppDoc;
    expect(greetingText(restored)).toBe("Hello");

    // The composed store reflects the restore.
    const afterUndo = (await (await stack.wireFetch(`/apps/${appId}`, {}, ADA)).json()) as AppDoc;
    expect(greetingText(afterUndo)).toBe("Hello");
  });
});

import { describe, expect, it } from "vitest";
import { VENDO_APP_FORMAT, VENDO_TREE_FORMAT } from "./formats.js";
import {
  uiPayloadSchema,
  validateTree,
  type Tree,
  type UIPayload,
} from "./tree.js";
import { validateAppDocument, type AppDocument } from "./app-document.js";

/**
 * FORMAT-EVOLUTION FIRE DRILL — the CORE seam (01-core §8; 00-overview "How this
 * set evolves without breaking").
 *
 * A throwaway second UI format, registered nowhere in product source, proves the
 * format-tagged payload contract dispatches strictly on `formatVersion`:
 *  - any tag is a valid UIPayload (the tag owns everything past itself);
 *  - `validateTree` rejects a non-v1 tag as not-its-format (code "version");
 *  - the v0 tree still validates unchanged;
 *  - core makes NO assumption that a payload is a tree on the app-document path —
 *    `AppDocument.tree` is `UIPayload`, and `validateAppDocument` accepts a
 *    document whose tree carries the drill tag, contents untouched. That is the
 *    contract's "a future format slots in behind the tag without touching the
 *    app document shape."
 *
 * The drill tag lives ONLY in this test file; it is never a registered format.
 */
const DRILL_FORMAT = "vendo/tree@2-drill";

/** The drill format's shape is deliberately NOT tree-shaped (no root/nodes): a
 *  block list. If any core validator on the app-document path body-sniffed the
 *  payload as a tree, this shape would fail — it must not. */
interface DrillPayload extends UIPayload {
  formatVersion: typeof DRILL_FORMAT;
  blocks: Array<{ heading: string; body: string }>;
}

const drillPayload = (): DrillPayload => ({
  formatVersion: DRILL_FORMAT,
  blocks: [
    { heading: "Quarterly revenue", body: "$4,200 across 3 invoices" },
    { heading: "Next step", body: "Send the reminder" },
  ],
});

const v1Tree = (): Tree => ({
  formatVersion: VENDO_TREE_FORMAT,
  root: "root",
  nodes: [
    { id: "root", component: "Stack", children: ["title"] },
    { id: "title", component: "Text", props: { text: "Instant invoice" } },
  ],
});

describe("format-evolution fire drill — core dispatches by tag", () => {
  it("accepts any drill-tagged payload as a valid UIPayload, contents preserved", () => {
    const parsed = uiPayloadSchema.parse(drillPayload());
    expect(parsed.formatVersion).toBe(DRILL_FORMAT);
    // passthrough: everything past the tag survives untouched.
    expect(parsed).toEqual(drillPayload());
    expect((parsed as DrillPayload).blocks).toHaveLength(2);
  });

  it("validateTree rejects the drill tag as not-its-format with code \"version\"", () => {
    const result = validateTree(drillPayload());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("drill payload must not validate as a v1 tree");
    expect(result.error.code).toBe("version");
    expect(result.error.message).toContain(VENDO_TREE_FORMAT);
  });

  it("still validates the v0 tree unchanged", () => {
    const result = validateTree(v1Tree());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.tree.formatVersion).toBe(VENDO_TREE_FORMAT);
    expect(result.tree.root).toBe("root");
  });

  it("accepts an app document whose tree carries the drill tag, tree untouched", () => {
    // AppDocument.tree is typed UIPayload — the drill payload assigns with no cast.
    const tree: UIPayload = drillPayload();
    const doc: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_drill_1",
      name: "Drill app",
      tree,
    };

    const result = validateAppDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    // No tree-shape assumption: the non-tree block list round-trips verbatim.
    expect(result.app.tree).toEqual(drillPayload());
  });

  it("does not body-sniff the drill tree: an app-document shape that would fail v1 validation still passes", () => {
    // This payload has a `root` that names no node and `nodes: []` — a guaranteed
    // v1 provision failure. Under the tag it is opaque, so the document is valid.
    const hostileIfSniffed: UIPayload = {
      formatVersion: DRILL_FORMAT,
      root: "does-not-exist",
      nodes: [],
      blocks: [{ heading: "opaque", body: "past the tag" }],
    };
    // Prove the shape WOULD fail if core treated it as a v1 tree...
    const asTree = validateTree({ ...hostileIfSniffed, formatVersion: VENDO_TREE_FORMAT });
    expect(asTree.ok).toBe(false);

    // ...yet the drill-tagged document is accepted, because the tag owns the body.
    const result = validateAppDocument({
      format: VENDO_APP_FORMAT,
      id: "app_drill_2",
      name: "Drill app 2",
      tree: hostileIfSniffed,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    expect(result.app.tree).toEqual(hostileIfSniffed);
  });

  it("still validates an app document carrying the v0 tree (stored-record compatible)", () => {
    const result = validateAppDocument({
      format: VENDO_APP_FORMAT,
      id: "app_v1_1",
      name: "V1 app",
      tree: v1Tree(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    expect(result.app.tree?.formatVersion).toBe(VENDO_TREE_FORMAT);
  });
});

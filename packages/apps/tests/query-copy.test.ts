/**
 * A query has FOUR states — loading, failed, empty, data — and the Kit's props
 * only ever named one of them (`emptyState`). So a read that had not arrived, and
 * a read that FAILED, both rendered as "No data": the lie `useToolQuery`'s own
 * header forbids ("a failed load must never read as 'you have no spending'").
 *
 * The two missing sentences are the query's, filled from its name the moment a
 * document lands, so the author writes none of it. This is the SEAM, both ends
 * real: the render seam fills, the printer prints what a checkout writes into
 * `app.vendo`, and the compiler reads that same document back.
 */
import { describe, expect, it } from "vitest";
import type { Json, VendoViewPart } from "@vendoai/core";
import { compileWire, printWire, withQueryCopy } from "../src/contract/index.js";
import { viewForWrite, wrapWorkspaceForRender } from "../src/server/generation/render-seam.js";
import { testWorkspace } from "./test-doubles.test-util.js";

const APP = "app_1";
const APP_VENDO = `/user/apps/${APP}/app.vendo`;

const WIRE = `<App name="Accounts">
  <Query id="accounts" tool="maple_accounts_list" />
  <Query id="spend_by_category" tool="maple_spend_summary" whileLoading="Adding it up…" />
  <Stack>
    <DataTable rows={accounts.data} />
  </Stack>
</App>`;

/** The seam as the runtime wires it: `authoredApp` is what stores the document,
 *  so the tree it receives is the tree a checkout later prints. */
function seam() {
  const handed: Array<{ queries: Array<Record<string, unknown>> }> = [];
  const emitted: VendoViewPart[] = [];
  const workspace = wrapWorkspaceForRender(testWorkspace(), {
    emit: (_id, part) => emitted.push(part),
    authoredApp: async ({ compiled }) => {
      handed.push({ queries: (compiled.tree.queries ?? []) as unknown as Array<Record<string, unknown>> });
      return { data: {} as Record<string, Json> };
    },
  });
  return {
    handed,
    emitted,
    save: async (content: string): Promise<void> => {
      await workspace.writeFile(APP_VENDO, content);
      await workspace.commit();
    },
  };
}

describe("the words a query shows where its data would be", () => {
  it("fills both missing states from the query's own name when the document lands", async () => {
    const { handed, save } = seam();
    await save(WIRE);

    expect(handed).toHaveLength(1);
    expect(handed[0]?.queries[0]).toEqual({
      name: "accounts",
      tool: "maple_accounts_list",
      whileLoading: "Loading accounts…",
      onError: "Couldn't load accounts.",
    });
  });

  it("never overwrites the author's own copy, and says the name out loud", async () => {
    const { handed, save } = seam();
    await save(WIRE);

    expect(handed[0]?.queries[1]).toEqual({
      name: "spend_by_category",
      tool: "maple_spend_summary",
      whileLoading: "Adding it up…",
      onError: "Couldn't load spend by category.",
    });
  });

  it("rides the painted payload, which is what the renderer reads them off", async () => {
    const { emitted, save } = seam();
    await save(WIRE);

    const settled = emitted.at(-1)!.payload as { queries?: Array<{ onError?: string }> };
    expect(settled.queries?.map((query) => query.onError))
      .toEqual(["Couldn't load accounts.", "Couldn't load spend by category."]);
  });

  it("prints into the document a checkout writes, and reads back unchanged", () => {
    const compiled = compileWire(WIRE);
    compiled.tree.queries = compiled.tree.queries?.map(withQueryCopy);

    // The bytes a checkout puts in front of the next reader of this app.
    const printed = printWire(compiled, { includeIds: true });
    expect(printed).toContain('whileLoading="Loading accounts…"');
    expect(printed).toContain('onError="Couldn\'t load accounts."');
    // …and the compiler reads its own printed copy back as the same document,
    // so the sentences are the author's to edit, not decoration.
    expect(compileWire(printed).tree.queries).toStrictEqual(compiled.tree.queries);
  });

  it("says nothing about a document with no queries in it", async () => {
    const view = await viewForWrite(APP_VENDO, '<App name="X"><Stack><Text text="hi"/></Stack></App>', {
      emit: () => undefined,
    });
    expect((view?.part.payload as { queries?: unknown }).queries).toBeUndefined();
  });
});

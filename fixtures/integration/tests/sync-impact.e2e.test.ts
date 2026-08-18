/** ENG-261 — sync blast radius over the real composed wire and store. */
import { VENDO_APP_FORMAT, type AppDocument } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADA,
  createAutomation,
  createStack,
  decideApprovals,
  importApp,
  resetFixture,
  type Stack,
  type WireApproval,
} from "../src/harness.js";

const TOOL = "host_invoices_list";

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

function plainApp(): AppDocument {
  return {
    format: VENDO_APP_FORMAT,
    id: "app_import_placeholder",
    name: "Invoice viewer",
    ui: "tree",
    components: { Invoices: "export default function Invoices(){ return null; }" },
  };
}

const EVENT = "sync-impact.refresh";

describe("ENG-261: sync impact through the composed wire", () => {
  it("maps a tool to its automation and active standing grant", async () => {
    await resetFixture();
    // `vendo sync` talks to a dev server, and only a development composition
    // mounts the route it talks to. This stack opts in the way that dev server
    // does; the sibling test below is the same wire without the opt-in.
    stack = await createStack({ development: true });

    const app = await importApp(stack, plainApp(), ADA);
    // Imported documents are intentionally disabled at rest and the public wire
    // has no enable route for plain apps; flip only that persisted operator bit.
    await stack.sql("UPDATE vendo_apps SET enabled = true WHERE id = $1", [app.id]);
    const automated = await createAutomation(stack, {
      owner: ADA,
      when: { event: EVENT },
      task: { kind: "steps", steps: [{ id: "list", tool: TOOL }] },
    });
    const enabled = (await (await stack.wireFetch(
      `/automations/${automated.id}/enable`,
      { method: "POST" },
      ADA,
    )).json()) as { enabled: boolean; missing: WireApproval[] };
    expect(enabled).toMatchObject({ enabled: true });
    expect(enabled.missing.map((request) => request.call.tool)).toEqual([TOOL]);
    expect((await decideApprovals(
      stack,
      enabled.missing.map((request) => request.id),
      { approve: true },
      ADA,
    )).status).toBe(200);

    const response = await stack.wireFetch("/sync/impact", {
      method: "POST",
      body: JSON.stringify({ tools: [TOOL, "host_absent"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      impact: [
        {
          tool: TOOL,
          // EMPTY, and honestly so. No door this deployment has writes an app row
          // that names a tool: import does not copy `componentTools`, and the
          // reader does not look at the `app.tsx` where a screen's reads actually
          // live. Hand-writing the manifest here would have proved only that the
          // reader reads a field.
          apps: [],
          // A record has no name — it has a WHEN, which is what a person would
          // recognize it by in the report.
          automations: [{ id: automated.id, title: `on ${EVENT}` }],
          grants: 1,
        },
        { tool: "host_absent", apps: [], automations: [], grants: 0 },
      ],
    });
  });

  it("is not mounted at all on a stack that did not opt into development", async () => {
    await resetFixture();
    stack = await createStack();

    const app = await importApp(stack, plainApp(), ADA);
    await stack.sql("UPDATE vendo_apps SET enabled = true WHERE id = $1", [app.id]);

    // No principal header — the unidentified caller the old NODE_ENV-only gate
    // handed the whole deployment's app inventory to. The route is absent, so
    // the 404 lands ahead of any identity question.
    const response = await stack.wireFetch("/sync/impact", {
      method: "POST",
      body: JSON.stringify({ tools: [TOOL] }),
    });

    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain(app.id);
  });
});

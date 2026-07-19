/** ENG-261 — sync blast radius over the real composed wire and store. */
import { VENDO_APP_FORMAT, VENDO_TREE_FORMAT_V2, type AppDocument } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADA,
  createStack,
  decideApprovals,
  importAutomation,
  resetFixture,
  type Stack,
  type WireApproval,
} from "./harness.js";

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
    tree: {
      formatVersion: VENDO_TREE_FORMAT_V2,
      root: "root",
      nodes: [{ id: "root", component: "Text", props: { text: "Invoices" } }],
      queries: [{ name: "invoices", tool: TOOL }],
    },
  };
}

function automation(): AppDocument {
  return {
    format: VENDO_APP_FORMAT,
    id: "app_import_placeholder",
    name: "Invoice refresh",
    trigger: {
      on: { kind: "host-event", event: "sync-impact.refresh" },
      run: { kind: "steps", steps: [{ id: "list", tool: TOOL }] },
    },
  };
}

describe("ENG-261: sync impact through the composed wire", () => {
  it("maps a tool to its saved app, automation, and active standing grant", async () => {
    await resetFixture();
    stack = await createStack();

    const app = await importAutomation(stack, plainApp(), ADA);
    // Imported documents are intentionally disabled at rest and the public wire
    // has no enable route for plain apps; flip only that persisted operator bit.
    await stack.sql("UPDATE vendo_apps SET enabled = true WHERE id = $1", [app.id]);
    const automated = await importAutomation(stack, automation(), ADA);
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
          apps: [{ id: app.id, title: "Invoice viewer" }],
          automations: [{ id: automated.id, title: "Invoice refresh" }],
          grants: 1,
        },
        { tool: "host_absent", apps: [], automations: [], grants: 0 },
      ],
    });
  });
});

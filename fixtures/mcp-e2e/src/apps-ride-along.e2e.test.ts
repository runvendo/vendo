import { beforeEach, describe, expect, it } from "vitest";
import { createStack, FIXTURE_APP_ID, HTTP_FIXTURE_APP_ID, resetFixture } from "./harness.js";
import { connectWithSdk, textOf } from "./support.js";

const SHIM_URI = "ui://vendo/tree-shim.html";

describe("saved apps ride along as MCP Apps", () => {
  beforeEach(resetFixture);

  it("lists UI metadata, opens a real app, serves the shim, and guards app calls", async () => {
    const stack = await createStack();
    try {
      const connected = await connectWithSdk(stack);
      try {
        const listed = await connected.client.listTools();
        for (const name of ["vendo_apps_open", "vendo_apps_call"]) {
          const descriptor = listed.tools.find((tool) => tool.name === name);
          expect(descriptor?._meta).toMatchObject({ ui: { resourceUri: SHIM_URI } });
        }

        const opened = await connected.client.callTool({
          name: "vendo_apps_open",
          arguments: { appId: FIXTURE_APP_ID },
        });
        expect(opened.isError).not.toBe(true);
        expect(opened.structuredContent).toMatchObject({
          formatVersion: "vendo-genui/v1",
          data: { fixture: true },
        });

        const resource = await connected.client.readResource({ uri: SHIM_URI });
        expect(resource.contents).toHaveLength(1);
        expect(resource.contents[0]).toMatchObject({
          uri: SHIM_URI,
          mimeType: "text/html;profile=mcp-app",
        });
        const html = "text" in resource.contents[0]! ? resource.contents[0].text : "";
        expect(html.length).toBeGreaterThan(500);
        expect(html).toContain("<!doctype html>");
        expect(stack.resourceReads).toContain(SHIM_URI);
        expect(html).toContain("--vendo-color-background:#FBFBFA");
        expect(html).toContain("--vendo-color-accent:#0A7CFF");
        expect(html.slice(0, html.indexOf("<script>"))).not.toContain("--color-text-primary");

        const called = await connected.client.callTool({
          name: "vendo_apps_call",
          arguments: {
            appId: FIXTURE_APP_ID,
            ref: "host_invoices_update",
            args: { id: "inv_0003", memo: "updated over MCP Apps" },
          },
        });
        expect(called.isError).not.toBe(true);
        expect(textOf(called)).toContain("updated over MCP Apps");
        // Two perimeters, two audit rows (10-mcp §2 + §4): the door tool call
        // itself is a venue=mcp guard decision, and the ref it forwards runs
        // guard-bound inside apps as venue=app with the running app attached.
        expect(await stack.sql(
          "SELECT tool, venue FROM vendo_audit WHERE kind = 'tool-call' AND tool = 'vendo_apps_call'",
        )).toEqual([{ tool: "vendo_apps_call", venue: "mcp" }]);
        expect(await stack.sql(
          "SELECT tool, venue, app_id FROM vendo_audit WHERE kind = 'tool-call' AND tool = 'host_invoices_update'",
        )).toEqual([{ tool: "host_invoices_update", venue: "app", app_id: FIXTURE_APP_ID }]);
      } finally {
        await connected.close();
      }
    } finally {
      await stack.close();
    }
  });

  it("opens a rung-4 fixture as an explicit link-out envelope", async () => {
    const stack = await createStack();
    try {
      const connected = await connectWithSdk(stack);
      try {
        const opened = await connected.client.callTool({
          name: "vendo_apps_open",
          arguments: { appId: HTTP_FIXTURE_APP_ID },
        });
        expect(opened.isError).not.toBe(true);
        expect(opened.structuredContent).toEqual({
          kind: "vendo/open-in-product@1",
          url: `${stack.origin}/fixture/apps/${HTTP_FIXTURE_APP_ID}`,
          appName: "MCP hosted dashboard",
          productName: expect.any(String),
        });
        expect(textOf(opened)).toMatch(
          new RegExp(`Open MCP hosted dashboard in .+: ${stack.origin}/fixture/apps/${HTTP_FIXTURE_APP_ID}`),
        );
      } finally {
        await connected.close();
      }
    } finally {
      await stack.close();
    }
  });
});

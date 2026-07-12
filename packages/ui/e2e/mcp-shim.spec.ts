import { expect, test, type Page } from "@playwright/test";
import type { Tree, UIPayload } from "@vendoai/core";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { browserTreeFixture } from "./fixtures/tree.js";

const shimTree: Tree = {
  ...browserTreeFixture,
  queries: [{ path: "/invoice/total", tool: "host_invoice_total", input: { invoiceId: "inv_42" } }],
  nodes: [
    ...browserTreeFixture.nodes.map((node) => node.id === "root"
      ? { ...node, children: [...(node.children ?? []), "query-value", "shim-action"] }
      : node),
    { id: "query-value", component: "Text", props: { text: { $path: "/invoice/total" } } },
    {
      id: "shim-action",
      component: "ShimAction",
      source: "generated",
      props: { onRun: { $action: "fn:refresh", payload: { source: "mcp-shim" } } },
    },
  ],
  components: {
    ShimAction: `export default function ShimAction({ onRun }) {
      return <button type="button" onClick={() => onRun()}>Run shim action</button>;
    }`,
  },
};

async function loadShim(page: Page, payload: UIPayload): Promise<void> {
  await page.setContent(`<!doctype html><iframe id="shim-frame" title="Vendo MCP Apps shim"></iframe><script>
    window.__shimCalls = [];
    window.__shimPayload = ${JSON.stringify(payload)};
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.method === "ui/initialize") {
        event.source.postMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "stub-mcp-host", version: "1.0.0" },
            hostCapabilities: { serverTools: {} },
            hostContext: {},
          },
        }, "*");
        return;
      }
      if (message.method === "ui/notifications/initialized") {
        event.source.postMessage({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: { appId: "app_shim" } },
        }, "*");
        event.source.postMessage({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            content: [{ type: "text", text: JSON.stringify(window.__shimPayload) }],
            structuredContent: window.__shimPayload,
          },
        }, "*");
        return;
      }
      if (message.method === "tools/call") {
        window.__shimCalls.push({ name: message.params.name, arguments: message.params.arguments });
        const output = message.params.arguments?.ref === "host_invoice_total" ? 7300 : { accepted: true };
        event.source.postMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ status: "ok", output }) }],
            structuredContent: { status: "ok", output },
          },
        }, "*");
      }
    });
  </script>`);
  const generated = await readFile(new URL("../../mcp/src/shim/shim-html.gen.ts", import.meta.url), "utf8");
  const match = generated.match(/export const SHIM_HTML: string = (.*);\s*$/s);
  if (!match) throw new Error("The generated MCP Apps shim artifact is malformed");
  const shimHtml = JSON.parse(match[1]!) as string;
  await page.locator("#shim-frame").evaluate((frame, html) => {
    (frame as HTMLIFrameElement).srcdoc = html;
  }, shimHtml);
}

test("generated MCP Apps shim renders a tree and bridges queries and actions", async ({ page }) => {
  await loadShim(page, shimTree as unknown as UIPayload);
  const shim = page.frameLocator("#shim-frame");

  await expect(shim.getByText("Instant-path invoice")).toBeVisible();
  await expect(shim.getByText("7300")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shimCalls: unknown[] }).__shimCalls)).toContainEqual({
    name: "vendo_apps_call",
    arguments: {
      appId: "app_shim",
      ref: "host_invoice_total",
      args: { invoiceId: "inv_42" },
    },
  });

  const generated = shim
    .frameLocator('iframe[title="Generated component: ShimAction"]')
    .frameLocator('iframe[title="Generated Vendo component"]');
  await generated.getByRole("button", { name: "Run shim action" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shimCalls: unknown[] }).__shimCalls)).toContainEqual({
    name: "vendo_apps_call",
    arguments: {
      appId: "app_shim",
      ref: "fn:refresh",
      args: { source: "mcp-shim" },
    },
  });

  await page.screenshot({
    path: fileURLToPath(new URL("../../../.lanes/shim-render.png", import.meta.url)),
    fullPage: true,
  });
});

test("generated MCP Apps shim contains unknown UI formats", async ({ page }) => {
  await loadShim(page, { formatVersion: "vendo-genui/future", message: "future payload" });
  const shim = page.frameLocator("#shim-frame");
  await expect(shim.getByRole("note", { name: "Unsupported UI format" })).toContainText("vendo-genui/future");
});

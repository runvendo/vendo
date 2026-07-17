import { expect, test, type Page } from "@playwright/test";
import type { Tree, UIPayload, VendoTheme } from "@vendoai/core";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { themeCssVariables } from "../src/theme.js";
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

const themeProofTree: Tree = {
  formatVersion: "vendo-genui/v1",
  root: "root",
  nodes: [
    { id: "root", component: "Surface", children: ["content"] },
    { id: "content", component: "Stack", props: { gap: 12 }, children: ["title", "caption", "proof"] },
    { id: "title", component: "Text", props: { text: "Host app inside MCP", variant: "heading" } },
    {
      id: "caption",
      component: "Text",
      props: { text: "The host palette crosses both iframe boundaries.", variant: "caption" },
    },
    { id: "proof", component: "ThemeProof", source: "generated" },
  ],
  components: {
    ThemeProof: `export default function ThemeProof() {
      return <section data-theme-proof style={{
        display: "grid",
        gap: 6,
        padding: 16,
        color: "var(--vendo-color-accent-text)",
        background: "var(--vendo-color-accent)",
        borderRadius: "var(--vendo-radius-medium)",
        fontFamily: "var(--vendo-font-family)",
      }}>
        <strong style={{ fontSize: 17 }}>Generated component</strong>
        <span>The same --vendo-* tokens reached the jail.</span>
      </section>;
    }`,
  },
};

async function loadShim(page: Page, payload: unknown, theme?: VendoTheme): Promise<void> {
  await page.setContent(`<!doctype html><iframe id="shim-frame" title="Vendo MCP Apps shim" style="width:480px;height:360px;border:0"></iframe><script>
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
  const genericShimHtml = JSON.parse(match[1]!) as string;
  const declarations = theme === undefined
    ? ""
    : Object.entries(themeCssVariables(theme)).map(([name, value]) => `${name}:${value};`).join("");
  const shimHtml = genericShimHtml.replace(
    "<!--VENDO_MCP_THEME-->",
    theme === undefined ? "" : `<style data-vendo-mcp-theme>:root{${declarations}}</style>`,
  );
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

test("generated MCP Apps shim renders a branded HTTP link-out card", async ({ page }) => {
  await loadShim(page, {
    kind: "vendo/open-in-product@1",
    url: "https://apps.example/revenue",
    appName: "Revenue dashboard",
    productName: "Maple",
  });
  const shim = page.frameLocator("#shim-frame");
  const card = shim.getByRole("region", { name: "Open Revenue dashboard in Maple" });

  await expect(card).toBeVisible();
  await expect(card.getByRole("heading", { name: "Revenue dashboard" })).toBeVisible();
  await expect(card.getByText("Open in Maple")).toBeVisible();
  const link = card.getByRole("link", { name: "Open Revenue dashboard" });
  await expect(link).toHaveAttribute("href", "https://apps.example/revenue");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toBeVisible();
  await expect(link).toBeInViewport();
  const [cardBox, linkBox] = await Promise.all([card.boundingBox(), link.boundingBox()]);
  expect(cardBox).not.toBeNull();
  expect(linkBox).not.toBeNull();
  expect(linkBox!.y + linkBox!.height).toBeLessThanOrEqual(cardBox!.y + cardBox!.height);

  const screenshotDir = new URL("../../../docs/screenshots/", import.meta.url);
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({
    path: fileURLToPath(new URL("eng-278-http-open-card.png", screenshotDir)),
    clip: cardBox!,
    animations: "disabled",
  });
});

test("generated MCP Apps shim carries the Maple theme through the generated-component jail", async ({ page }) => {
  const screenshotDir = new URL("../../../docs/verification/eng-274/", import.meta.url);
  await mkdir(screenshotDir, { recursive: true });

  await loadShim(page, themeProofTree as unknown as UIPayload);
  const unbrandedShim = page.frameLocator("#shim-frame");
  const unbrandedGenerated = unbrandedShim
    .frameLocator('iframe[title="Generated component: ThemeProof"]')
    .frameLocator('iframe[title="Generated Vendo component"]');
  await expect(unbrandedGenerated.locator("[data-theme-proof]")).toBeVisible();
  await expect.poll(() => unbrandedGenerated.locator("html").evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--vendo-color-accent").trim())).toBe("#2f5af5");
  await page.locator("#shim-frame").screenshot({
    path: fileURLToPath(new URL("eng-274-theme-unbranded.png", screenshotDir)),
    animations: "disabled",
  });

  const mapleTheme = JSON.parse(await readFile(
    new URL("../../../apps/demo-bank/.vendo/theme.json", import.meta.url),
    "utf8",
  )) as VendoTheme;
  await loadShim(page, themeProofTree as unknown as UIPayload, mapleTheme);
  const mapleShim = page.frameLocator("#shim-frame");
  const mapleGenerated = mapleShim
    .frameLocator('iframe[title="Generated component: ThemeProof"]')
    .frameLocator('iframe[title="Generated Vendo component"]');
  await expect(mapleShim.getByText("Host app inside MCP")).toBeVisible();
  await expect.poll(() => mapleShim.locator("body").evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    color: getComputedStyle(element).color,
  }))).toEqual({ background: "rgb(251, 251, 250)", color: "rgb(17, 17, 17)" });
  await expect.poll(() => mapleGenerated.locator("html").evaluate((element) => ({
    accent: getComputedStyle(element).getPropertyValue("--vendo-color-accent").trim(),
    radius: getComputedStyle(element).getPropertyValue("--vendo-radius-medium").trim(),
  }))).toEqual({ accent: "#111111", radius: "14px" });
  await expect.poll(() => mapleGenerated.locator("[data-theme-proof]").evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    radius: getComputedStyle(element).borderRadius,
  }))).toEqual({ background: "rgb(17, 17, 17)", radius: "14px" });
  await page.locator("#shim-frame").screenshot({
    path: fileURLToPath(new URL("eng-274-theme-maple.png", screenshotDir)),
    animations: "disabled",
  });
});

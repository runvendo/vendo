import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import {
  MCP_APPS_INVOICE_ID,
  MCP_APPS_UPDATED_MEMO,
} from "./harness/mcp-fixture.js";

const SHIM_URI = "ui://vendo/tree-shim.html";
const SHIM_MIME_TYPE = "text/html;profile=mcp-app";

test("ENG-276: a real MCP client hosts the shim, executes an action, and parks a destructive ref", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const reset = await request.post("/__test/reset");
  expect(reset.ok()).toBeTruthy();

  await page.goto("/mcp-apps");
  const card = page.getByTestId("mcp-apps-card");
  await expect(card).toHaveAttribute("data-resource-uri", SHIM_URI, { timeout: 30_000 });
  await expect(card).toHaveAttribute("data-resource-mime-type", SHIM_MIME_TYPE);
  await expect(page.getByTestId("mcp-host-status")).toHaveText(
    "Rendered from resources/read through the real MCP door",
    { timeout: 30_000 },
  );

  // AppBridge delivered the real vendo_apps_open input/result to the fetched
  // resource, and the actual shim renderer committed the fixture tree to DOM.
  const shim = page.frameLocator("#mcp-apps-shim");
  await expect(shim.getByText("MCP invoice control", { exact: true })).toBeVisible();
  await expect(shim.getByText(`Invoice ${MCP_APPS_INVOICE_ID} is rendered from the real door resource.`))
    .toBeVisible();

  const generated = shim
    .frameLocator('iframe[title="Generated component: InvoiceActions"]')
    .frameLocator('iframe[title="Generated Vendo component"]');

  // Click inside the generated-component jail. The bridge forwards tools/call
  // to the SDK client, then through the real door and app/runtime guard to the
  // fixture host's PATCH endpoint.
  await generated.getByRole("button", { name: "Update invoice" }).click();
  await expect(generated.getByText("Updated: ok")).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => {
    const response = await request.get(`/__test/host/invoice/${MCP_APPS_INVOICE_ID}`);
    const body = await response.json() as { invoice?: { memo?: string } };
    return body.invoice?.memo;
  }).toBe(MCP_APPS_UPDATED_MEMO);

  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await card.screenshot({
    path: fileURLToPath(new URL("./artifacts/mcp-apps-shim-rendered.png", import.meta.url)),
  });

  // The destructive ref traverses the same route but the guard parks it. Both
  // the nested action control and the shim's tree outcome surface that state;
  // the real host record remains untouched.
  await generated.getByRole("button", { name: "Delete invoice" }).click();
  await expect(generated.getByText("Delete: pending-approval")).toBeVisible({ timeout: 20_000 });
  await expect(shim.getByRole("note", { name: "Action pending approval" }))
    .toContainText("Action is waiting for approval");
  await expect.poll(async () => {
    const response = await request.get(`/__test/host/invoice/${MCP_APPS_INVOICE_ID}`);
    return (await response.json() as { exists: boolean }).exists;
  }).toBe(true);

  const evidence = await request.get("/__test/mcp/evidence");
  expect(evidence.ok()).toBeTruthy();
  const { rows } = await evidence.json() as {
    rows: Array<{ tool: string; venue: string; app_id?: string }>;
  };
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ tool: "vendo_apps_open", venue: "mcp" }),
    expect.objectContaining({ tool: "host_invoices_update", venue: "app" }),
    expect.objectContaining({ tool: "host_invoices_delete", venue: "app" }),
  ]));
  expect(rows.filter((row) => row.tool === "vendo_apps_call" && row.venue === "mcp")).toHaveLength(2);

  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await card.screenshot({
    path: fileURLToPath(new URL("./artifacts/mcp-apps-shim-pending-approval.png", import.meta.url)),
  });
});

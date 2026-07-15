import { expect, test } from "@playwright/test";
import { jailFrame, openScenario } from "./helpers.js";

test("generated components stay in the opaque-origin CSP jail and actions cross only the bridge", async ({ page }) => {
  const escapedRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", request => {
    if (request.url().includes("example.com")) escapedRequests.push(request.url());
  });
  page.on("pageerror", error => pageErrors.push(error.message));

  await openScenario(page, "tree-jail");
  const iframe = page.locator('iframe[title="Generated component: SecurityProbe"]');
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  const jail = jailFrame(page, "SecurityProbe");
  await expect(jail.getByRole("heading", { name: "Rendered generated props" })).toBeVisible();

  await jail.getByRole("button", { name: "Probe fetch" }).click();
  await expect(jail.locator("#fetch-status")).toHaveText("fetch: FAILURE (CSP)");
  await jail.getByRole("button", { name: "Probe import" }).click();
  await expect(jail.locator("#import-status")).toHaveText("import: FAILURE (CSP)");
  await jail.getByRole("button", { name: "Probe parent DOM" }).click();
  await expect(jail.locator("#parent-status")).toHaveText("parent: FAILURE (opaque origin)");
  expect(escapedRequests, "CSP must stop example.com before a browser request leaves").toEqual([]);

  await jail.getByRole("button", { name: "Dispatch action" }).click();
  await expect(jail.locator("#action-status")).toHaveText("action: delivered");
  await expect(page.getByTestId("action-recorder")).toHaveText(JSON.stringify({
    nodeId: "probe",
    action: "fn:secure-submit",
    payload: { invoiceId: "inv_42" },
  }));

  const generatedNotices = page.getByRole("note", { name: "Generated component error" });
  await expect(generatedNotices.filter({ hasText: "generated render exploded inside its jail" })).toBeVisible();
  await expect(generatedNotices.filter({ hasText: "EmptyGeneratedComponent: generated component rendered no content" })).toBeVisible();
  await expect(page.getByText("Jail sibling survived")).toBeVisible();
  expect(pageErrors, "jail failures must be reported in-surface, not as uncaught page errors").toEqual([]);
});

test("a pin fork renders with captured sub-components, root CSS, and sample props", async ({ page }) => {
  await openScenario(page, "tree-jail");
  const jail = jailFrame(page, "FurnishedPin");

  await expect(jail.getByRole("heading", { name: "Furnished fork for Ada" })).toBeVisible();
  await expect(jail.getByText("Stubbed invoice total: $4,200")).toBeVisible();
  await expect(jail.getByText("captured styles")).toBeVisible();
  await expect(jail.locator(".furnished-pin-card")).toHaveCSS("background-color", "rgb(239, 246, 255)");
  await expect(jail.locator('style[data-vendo-host-style="src/app/globals.css"]')).toHaveCount(1);
  await expect(page.locator("style[data-vendo-host-style]")).toHaveCount(0);
  await expect(page
    .frameLocator('iframe[title="Generated component: FurnishedPin"]')
    .locator("style[data-vendo-host-style]"))
    .toHaveCount(0);
});

test("generated component iframe height follows content growth and shrinkage without feedback", async ({ page }) => {
  await openScenario(page, "tree-jail");
  const iframe = page.locator('iframe[title="Generated component: SecurityProbe"]');
  const jail = jailFrame(page, "SecurityProbe");
  const mount = jail.locator("#vendo-jail-root");
  await expect(jail.getByRole("heading", { name: "Rendered generated props" })).toBeVisible();

  const frameHeight = () => iframe.evaluate(element => element.getBoundingClientRect().height);
  const contentHeight = () => mount.evaluate(element => element.getBoundingClientRect().height);
  const heightDelta = async () => Math.abs(await frameHeight() - await contentHeight());

  await expect.poll(heightDelta).toBeLessThanOrEqual(1);
  const collapsedHeight = await frameHeight();

  await jail.getByRole("button", { name: "Expand content" }).click();
  await expect.poll(frameHeight).toBeGreaterThan(collapsedHeight + 400);
  await expect.poll(heightDelta).toBeLessThanOrEqual(1);
  const expandedHeight = await frameHeight();

  await jail.getByRole("button", { name: "Collapse content" }).click();
  await expect.poll(frameHeight).toBeLessThan(expandedHeight - 400);
  await expect.poll(heightDelta).toBeLessThanOrEqual(1);
  expect(await frameHeight()).toBeCloseTo(collapsedHeight, 0);
});

test("tree node failures and dangling children remain contained", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await openScenario(page, "tree");

  await expect(page.getByText("Instant-path invoice")).toBeVisible();
  await expect(page.getByText("Ada Lovelace")).toBeVisible();
  await expect(page.getByText("Bound total: 4200")).toBeVisible();
  await expect(page.getByRole("note", { name: "Node render error" })).toContainText("bad");
  await expect(page.getByText("Sibling survived")).toBeVisible();
  await expect(page.locator('[data-dangling-node="not-yet-streamed"] [data-primitive="Skeleton"]')).toBeVisible();
  await expect(page.locator("#root")).not.toBeEmpty();

  const unexpected = pageErrors.filter(message => !message.includes("host render exploded inside its node boundary"));
  expect(unexpected, "only the deliberately bounded host throw may be reported").toEqual([]);
});

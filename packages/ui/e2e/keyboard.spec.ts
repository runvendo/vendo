import { expect, test } from "@playwright/test";
import { expectFocusIndicator, expectKeyboardReachability, openScenario, tabTo } from "./helpers.js";

test("thread is keyboard-complete with visible focus", async ({ page }) => {
  await openScenario(page, "thread");
  await expect(page.getByLabel("Approval for Email send")).toBeVisible();
  await expectKeyboardReachability(page, 'main[data-scenario="thread"]');
  await tabTo(page, async () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") === null
    && document.activeElement?.textContent?.trim() === "Approve"));
  await page.keyboard.press("Enter");
  // The composer's accessible name comes from its wrapping <label>, not an
  // aria-label attribute — assert the accessible name, not the attribute.
  await tabTo(page, async () =>
    page.getByRole("textbox", { name: "Message" }).evaluate(element => element === document.activeElement));
  await page.keyboard.type("Keyboard-only turn");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Turn complete")).toBeVisible();
});

test("overlay focus trap and Escape are keyboard-complete", async ({ page }) => {
  await openScenario(page, "overlay");
  await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toBeVisible();
  await expectKeyboardReachability(page, '[role="dialog"]');
  await page.keyboard.press("Escape");
  const launcher = page.getByRole("button", { name: "AI agent" });
  await expect(launcher).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toBeVisible();
});

test("⌘K surface reaches and fires commands with keyboard only", async ({ page }) => {
  // One-surface ⌘K: the keybinding opens the conversation overlay; the
  // palette's commands are chips above the composer, keyboard-reachable
  // inside the focus trap. A second ⌘K (from anywhere inside the surface)
  // toggles it closed and focus restores to the invoker.
  await openScenario(page, "palette");
  const dialog = page.getByRole("dialog", { name: "Vendo assistant" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
  await tabTo(page, async () => page.evaluate(() => document.activeElement?.textContent?.trim() === "Open Invoices"));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("command-recorder")).toContainText('"appId":"app_1"');
  // Close-on-select for host-routed commands (the old palette behavior): the
  // surface dismisses itself so the host's navigation is never behind it.
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("palette-opener")).toBeFocused();
  // ⌘K reopens; a second ⌘K (from the focused composer inside) toggles closed.
  await page.keyboard.press("Control+K");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Control+K");
  await expect(dialog).toBeHidden();
});

test("automation controls are all keyboard reachable and execute by Enter", async ({ page }) => {
  await openScenario(page, "automations");
  await expect(page.getByRole("switch")).toBeVisible();
  await expectKeyboardReachability(page, 'main[data-scenario="automations"]');
  await tabTo(page, async () => page.evaluate(() => document.activeElement?.getAttribute("role") === "switch"));
  const before = await page.getByRole("switch").getAttribute("aria-checked");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("switch")).toHaveAttribute("aria-checked", before === "true" ? "false" : "true");
  await tabTo(page, async () => page.evaluate(() => document.activeElement?.textContent?.trim() === "Dry run"));
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Dry run for Invoice watcher")).toBeVisible();
});

test("a running automation is killed by keyboard from run history", async ({ page }) => {
  await openScenario(page, "automations");
  await expect(page.getByRole("switch")).toBeVisible();
  await tabTo(page, async () => page.evaluate(() => document.activeElement?.textContent?.trim() === "Run history"));
  await page.keyboard.press("Enter");
  const history = page.getByLabel("Run history for Invoice watcher");
  await expect(history.getByText("running")).toBeVisible();
  await tabTo(page, async () => page.evaluate(() => document.activeElement?.textContent?.trim() === "Stop"));
  await page.keyboard.press("Enter");
  await expect(history.getByText("stopped")).toBeVisible();
});

test("workspace tabs rove with arrows and open an app by keyboard", async ({ page }) => {
  await openScenario(page, "page");
  const apps = page.getByRole("tab", { name: "Apps" });
  await expect(apps).toHaveAttribute("aria-selected", "true");
  await expectKeyboardReachability(page, 'main[data-scenario="page"]');
  await apps.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Automations" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(apps).toHaveAttribute("aria-selected", "true");
  await tabTo(page, async () => page.evaluate(() => document.activeElement?.textContent?.trim() === "Open"));
  await page.keyboard.press("Enter");
  await expect(page.getByText("Invoices app surface").first()).toBeVisible();
});

test("voice stage starts and stops entirely by keyboard", async ({ page }) => {
  await openScenario(page, "stage");
  await expect(page.getByText("Revenue is ready")).toBeVisible();
  const toggle = page.getByRole("button", { name: "Stop voice" });
  await toggle.focus();
  await expectFocusIndicator(page);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Start voice" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Voice: idle");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop voice" })).toBeVisible();
});

test("activity load-more is keyboard reachable and appends a page", async ({ page }) => {
  await openScenario(page, "activity");
  const rows = page.locator('main[data-scenario="activity"] tbody tr');
  await expect(rows).toHaveCount(2);
  await tabTo(page, async () => page.evaluate(() => document.activeElement?.textContent?.trim() === "Load more"));
  await page.keyboard.press("Enter");
  await expect(rows).toHaveCount(3);
});

test("activity reaches an explicit end-of-list once history is exhausted", async ({ page }) => {
  await openScenario(page, "activity");
  const loadMore = page.getByRole("button", { name: "Load more" });
  // First page appends aud_3; the second repeats seen rows → end of the list.
  await loadMore.click();
  await expect(page.locator('main[data-scenario="activity"] tbody tr')).toHaveCount(3);
  await loadMore.click();
  await expect(page.getByTestId("activity-end")).toBeVisible();
  await expect(loadMore).toHaveCount(0);
});

test("a destructive approval can be denied entirely by keyboard", async ({ page }) => {
  await openScenario(page, "approval");
  await expect(page.getByLabel("Real tool inputs")).toContainText("permanent=true");
  // Reach the disclosure, Approve, and Deny by keyboard; deny with Enter.
  await tabTo(page, async () => page.evaluate(() => document.activeElement?.textContent?.trim() === "Approve"));
  await tabTo(page, async () => page.evaluate(() => document.activeElement?.textContent?.trim() === "Deny"));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("approval-recorder")).toHaveText('resolved: {"approve":false}');
});

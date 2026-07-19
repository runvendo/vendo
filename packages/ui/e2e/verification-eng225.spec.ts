import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * ENG-225 — verification captures (committed to docs/verification/eng-225/).
 * Not a behavioral gate (that is affordances-eng225.test.tsx); this spec
 * produces the PR screenshots: copy actions + code copy, drag-drop, attachment
 * chips, sent attachments, the waiting-on-you queue, the toast stack, and the
 * connect dock/tray — light and dark.
 */

const shotPath = (name: string) =>
  new URL(`../../../docs/verification/eng-225/${name}.png`, import.meta.url).pathname;

/** A real-sized PNG generated in the page (a 240×140 chart-ish gradient), so
 *  image previews and sent thumbnails read at actual size in the captures. */
async function chartPng(page: import("@playwright/test").Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 140;
    const ctx = canvas.getContext("2d")!;
    const gradient = ctx.createLinearGradient(0, 0, 240, 140);
    gradient.addColorStop(0, "#dbeafe");
    gradient.addColorStop(1, "#eff6ff");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 240, 140);
    ctx.fillStyle = "#2563eb";
    [34, 62, 48, 88, 70, 110].forEach((height, index) => {
      ctx.fillRect(16 + index * 36, 124 - height, 24, height);
    });
    return canvas.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.split(",")[1]!, "base64");
}

test("copy actions + code copy (Maple)", async ({ page }) => {
  await openScenario(page, "affordances");
  await expect(page.getByText("sandbox key first")).toBeVisible();
  // Hover the assistant turn so the actions row and the code Copy reveal.
  await page.locator(".fl-codeblock").hover();
  await expect(page.getByRole("button", { name: "Copy code" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy message" }).last()).toBeVisible();
  await page.screenshot({ path: shotPath("01-copy-actions-light"), animations: "disabled" });
  // The click lands the text on the clipboard and flips the label.
  await page.getByRole("button", { name: "Copy code" }).click();
  await expect(page.getByText("Copied").first()).toBeVisible();
});

test("drag-drop overlay + attachment chips", async ({ page }) => {
  await openScenario(page, "affordances");
  const composer = page.getByRole("form", { name: "Message composer" });
  // A synthetic file drag shows the designed drop zone…
  await composer.dispatchEvent("dragenter", {
    dataTransfer: await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "drag.txt", { type: "text/plain" }));
      return dt;
    }),
  });
  await expect(page.getByText("Drop files to attach")).toBeVisible();
  await page.screenshot({ path: shotPath("02-drop-zone"), animations: "disabled" });
  // Leave the drag so the overlay clears before the chip capture (the handler
  // only reacts to drags that carry Files, so the leave must carry one too).
  await composer.dispatchEvent("dragleave", {
    dataTransfer: await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "drag.txt", { type: "text/plain" }));
      return dt;
    }),
  });
  await expect(page.getByText("Drop files to attach")).toBeHidden();
  // …and attaching real files renders both chip shapes (image + file).
  await page.setInputFiles("input[type=file]", [
    { name: "chart.png", mimeType: "image/png", buffer: await chartPng(page) },
    { name: "report-q3.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fake") },
  ]);
  await expect(page.locator(".fl-att-img img")).toBeVisible();
  await expect(page.getByText("report-q3.pdf")).toBeVisible();
  await page.screenshot({ path: shotPath("03-attachment-chips"), animations: "disabled" });
});

test("sent attachments render beside the user bubble", async ({ page }) => {
  await openScenario(page, "affordances");
  await page.setInputFiles("input[type=file]", [
    { name: "chart.png", mimeType: "image/png", buffer: await chartPng(page) },
  ]);
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("Here's the chart I mentioned");
  await box.press("Enter");
  await expect(page.locator(".fl-turn-user-att .fl-msg-img img")).toBeVisible();
  await page.screenshot({ path: shotPath("04-sent-attachment"), animations: "disabled" });
});

test("waiting-on-you queue", async ({ page }) => {
  await openScenario(page, "waiting");
  await expect(page.getByRole("region", { name: "Waiting on you" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await page.screenshot({ path: shotPath("05-waiting-queue"), animations: "disabled" });
});

test("toast stack — delivery, error, approval-required", async ({ page }) => {
  await openScenario(page, "toasts");
  await expect(page.getByText("Invoice watcher ran")).toBeVisible();
  await expect(page.getByText("Morning digest failed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await page.screenshot({ path: shotPath("06-toasts"), animations: "disabled" });
});

test("connect dock + tray (Maple)", async ({ page }) => {
  await openScenario(page, "affordances");
  const dock = page.getByRole("button", { name: "Connect tools" });
  await expect(dock).toBeVisible();
  await expect(page.locator(".fl-dock-badge")).toHaveText("1");
  await dock.click();
  await expect(page.getByRole("dialog", { name: "Connect tools" })).toBeVisible();
  await expect(page.getByText("Connected")).toBeVisible();
  await expect(page.getByText("Available")).toBeVisible();
  await page.screenshot({ path: shotPath("07-connect-tray"), animations: "disabled" });
});

test("affordances — dark", async ({ page }) => {
  await openScenario(page, "affordances-dark");
  await page.locator(".fl-codeblock").hover();
  await expect(page.getByRole("button", { name: "Copy code" })).toBeVisible();
  await page.getByRole("button", { name: "Connect tools" }).click();
  await expect(page.getByRole("dialog", { name: "Connect tools" })).toBeVisible();
  await page.screenshot({ path: shotPath("08-affordances-dark"), animations: "disabled" });
});

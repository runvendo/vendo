import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * Wave-3 fix lane A, in a real browser — the consumer voice law (design §3) on
 * the sharing surfaces. Every case here was a sentence written for a HOST
 * DEVELOPER that reached the person using the product:
 *
 *  F1  "set VENDO_API_KEY" on every keyless (default OSS) deployment
 *  F2  a `createVendo({ store: createStore({ url }) })` snippet, via share→promote
 *  F11 "editor access is required for app_7c2f…" where the fork offer belonged
 *  F12 `team:acme/finance` typed into the visible input, and a "Person" option
 *      the placeholder promised but never offered
 *
 * Screenshots land in docs/verification/wave3-fix-a/ (gitignored, like every
 * other lane's).
 */

const SHOTS = new URL("../../../docs/verification/wave3-fix-a/", import.meta.url).pathname;

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

type SpecPage = Parameters<Parameters<typeof test>[1]>[0]["page"];

/** One named card, so a second app on the page can never be the one under test. */
const cardFor = (page: SpecPage, name: string) =>
  page.locator("article").filter({ hasText: name }).first();

/**
 * The two doors the Share dialog reads, stubbed HERE rather than in the shared
 * wire fixture: `/status` carries an exact shape that test/hooks.test.tsx pins
 * (`memberships: []`), and widening it for one browser spec broke that test.
 * The doors themselves are covered by their own suites (@vendoai/store's
 * app-access, @vendoai/apps' access, wire/apps.grants) — what this spec is for
 * is the rendered surface.
 */
async function stubSharingDoors(page: SpecPage): Promise<void> {
  await page.route("**/api/vendo/status", async (route) => {
    const answer = await route.fetch();
    const status = await answer.json() as Record<string, unknown>;
    await route.fulfill({
      response: answer,
      json: { ...status, memberships: [{ org: "acme", display: "Acme", teams: ["finance"] }] },
    });
  });
  // §9.5 — the caller OWNS this app and it is still personal, which is the state
  // "share implies promote" is about.
  await page.route("**/api/vendo/apps/*/grants", async (route) => {
    if (route.request().method() !== "GET") return await route.fallback();
    await route.fulfill({ json: { level: "owner", grants: [], personal: true } });
  });
  await page.route("**/api/vendo/apps/*/promote", async (route) => {
    await route.fulfill({ json: { id: "app_1", name: "Invoices" } });
  });
}

test("the share picker speaks human, and offers a person", async ({ page }) => {
  await stubSharingDoors(page);
  await openScenario(page, "page");
  const card = cardFor(page, "Invoices");
  await card.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = card.locator(".fl-share");

  const picker = dialog.getByLabel("Who to share with");
  await expect(picker).toBeVisible();
  // F12 — the raw §9.2 grammar is never on screen. It rides each option's value.
  await expect(dialog).not.toContainText("team:");
  await expect(dialog).not.toContainText("org:");
  await expect(picker.locator("option", { hasText: "A specific person" })).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}f12-share-picker.png`, fullPage: false });

  // The person option reveals its own labelled field rather than hiding the
  // requirement in a placeholder.
  await picker.selectOption({ label: "A specific person…" });
  await expect(dialog.getByLabel("Their name or email at work")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}f6-person-field.png` });
});

test("a keyless deployment's refusal is a consumer sentence, not an env var", async ({ page }) => {
  await stubSharingDoors(page);
  // Exactly what the wire throws with no Cloud key (runtime.ts requireMultiParty).
  await page.route("**/api/vendo/apps/*/grants", async (route) => {
    if (route.request().method() !== "POST") return await route.fallback();
    await route.fulfill({
      status: 402,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "cloud-required",
          message: "sharing needs Vendo Cloud: set VENDO_API_KEY (or pass a hosted store)"
            + " — apps you own alone keep working without it",
        },
      }),
    });
  });
  await openScenario(page, "page");

  const card = cardFor(page, "Invoices");
  await card.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = card.locator(".fl-share");
  await dialog.getByLabel("Who to share with").selectOption({ label: "Everyone at Acme" });
  await dialog.getByRole("button", { name: "Share", exact: true }).click();

  const alert = dialog.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("isn’t turned on");
  await expect(alert).not.toContainText("VENDO_API_KEY");
  await expect(alert).not.toContainText("hosted store");
  await page.screenshot({ path: `${SHOTS}f1-keyless-refusal.png` });
});

test("a stopped automation is findable, with the reason in the consumer's words", async ({ page }) => {
  // B-3 / §9.9 — a lapsed sponsorship STOPS the automation. The panel rendered
  // it as an ordinary "Disabled", which reads as something somebody switched
  // off, so nobody had a reason to come looking (E8-F2).
  await page.route("**/api/vendo/automations", async (route) => {
    const answer = await route.fetch();
    const entries = await answer.json() as Array<Record<string, unknown>>;
    const stopped = entries.map((item, index) => index === 0
      ? {
          ...item,
          enabled: false,
          stopped: {
            reason: "departure",
            summary: "This stopped because the person it ran as no longer has access to the app.",
          },
        }
      : item);
    await route.fulfill({ response: answer, json: stopped });
  });

  await openScenario(page, "automations");
  const row = page.locator(".fl-automation").first();
  // The state WORD, not merely the summary sentence that happens to contain it:
  // `stopped` outranks a run row still marked running, and "Disabled" (which
  // reads as somebody's choice) is gone.
  await expect(row.locator(".fl-auto-sub").first()).toHaveText("Stopped");
  await expect(row).toContainText("no longer has access to the app");
  await expect(row).not.toContainText("Disabled");
  await expect(row).not.toContainText("running now");
  await page.screenshot({ path: `${SHOTS}b3-stopped-automation.png` });
});

test("a viewer denied an EDIT is offered their own copy", async ({ page }) => {
  await openScenario(page, "page");
  // §9.4's one case: the caller provably sees the app and may not change it.
  await page.route("**/api/vendo/apps/*/edit", async (route) => {
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "forbidden", message: "editor access is required for app_1" },
      }),
    });
  });

  const card = cardFor(page, "Invoices");
  await card.getByRole("button", { name: "Change" }).click();
  await card.getByRole("form", { name: "Change Invoices" }).getByRole("textbox")
    .fill("show last quarter too");
  await card.getByRole("button", { name: "Save" }).click();

  const offer = page.locator(".fl-share-fork");
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("show last quarter too");
  await expect(offer).not.toContainText("editor access is required");
  await expect(page.getByRole("button", { name: "Make me my own copy" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}f11-fork-offer-on-edit.png` });
});

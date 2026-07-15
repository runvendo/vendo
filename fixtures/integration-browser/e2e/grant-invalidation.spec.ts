/** ENG-261 — a real Chromium journey over the composed umbrella proves that
 * descriptor drift both explains the replacement approval and appears in the
 * user-visible Activity panel. Set ENG261_SCREENSHOT_DIR to retain evidence. */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext, type Locator } from "@playwright/test";

const TOOL = "host_invoices_delete";
const FIRST = "inv_0006";
const SECOND = "inv_0005";
const THREAD = "thr_eng_261_browser";

async function script(request: APIRequestContext): Promise<void> {
  await expect(async () => {
    expect((await request.post("/__test/reset")).ok()).toBeTruthy();
  }).toPass({ timeout: 30_000 });
  const response = await request.post("/__test/script", {
    data: {
      turns: [
        { kind: "tool", name: TOOL, input: { id: FIRST }, toolCallId: "call_grant_v1" },
        { kind: "text", text: "Deleted the first invoice.", id: "text_grant_v1" },
        { kind: "tool", name: TOOL, input: { id: SECOND }, toolCallId: "call_grant_v2" },
      ],
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function retain(locator: Locator, name: string): Promise<void> {
  const directory = process.env.ENG261_SCREENSHOT_DIR;
  if (!directory) return;
  const absolute = resolve(directory);
  await mkdir(absolute, { recursive: true });
  await locator.screenshot({ path: resolve(absolute, name) });
}

test("descriptor drift explains the replacement approval and Activity event", async ({ page, request }) => {
  await script(request);
  // Keep the standing grant scoped to Bob so this persistent browser backend
  // cannot authorize Ada's independent journey later in the same suite.
  await page.goto(`/?thread=${THREAD}&user=user_bob`);

  const composer = page.getByRole("textbox", { name: /message/i });
  await expect(composer).toBeVisible();
  await composer.fill(`Delete invoice ${FIRST}`);
  await composer.press("Enter");

  const firstApproval = page.getByRole("article", { name: `Approval for ${TOOL}` });
  await expect(firstApproval).toBeVisible();
  await firstApproval.getByText("Remember this decision").click();
  await firstApproval.getByRole("checkbox", { name: /Create a reusable grant/i }).check();
  await firstApproval.getByRole("radio", { name: "The whole tool" }).check();
  await firstApproval.getByRole("radio", { name: "Standing" }).check();
  await firstApproval.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Deleted the first invoice.")).toBeVisible();

  const drifted = await request.post("/__test/descriptor-drift", { data: { tool: TOOL } });
  expect(drifted.ok()).toBeTruthy();
  const hashes = await drifted.json() as { staleHash: string; currentHash: string };
  expect(hashes.currentHash).not.toBe(hashes.staleHash);

  await composer.fill(`Delete invoice ${SECOND}`);
  await composer.press("Enter");
  const replacement = page.getByRole("article", { name: `Approval for ${TOOL}` });
  await expect(replacement.getByRole("note", { name: "Previous permission invalidated" })).toContainText(
    "This tool changed since you approved it on",
  );

  // Reload proves both surfaces are backed by committed wire/store state: the
  // thread rehydrates its approval payload and Activity fetches persisted audit.
  // ENG-211 (08-ui amendment 2026-07-14): a supplied thread id unknown to the
  // server is discarded by the hook and the server mints the effective id — so
  // recover the id the server actually bound from the summaries listing (the
  // documented way hosts persist thread identity) and rehydrate THAT thread.
  let committedThreadId: string | undefined;
  await expect(async () => {
    const listed = await request.get("/api/vendo/threads", {
      headers: { "x-vendo-test-user": "user_bob" },
    });
    expect(listed.ok()).toBeTruthy();
    const summaries = await listed.json() as { id: string; title: string }[];
    committedThreadId = summaries.find((summary) => summary.title.includes(FIRST))?.id;
    expect(committedThreadId).toBeTruthy();
  }).toPass({ timeout: 10_000 });
  await page.goto(`/?thread=${committedThreadId}&user=user_bob`);
  const committedApproval = page.getByRole("article", { name: `Approval for ${TOOL}` });
  await expect(committedApproval.getByRole("note", { name: "Previous permission invalidated" })).toBeVisible();
  await retain(committedApproval, "approval-card-invalidated-grant.png");

  const activity = page.getByRole("region", { name: "Activity" });
  const event = activity.getByRole("row").filter({ hasText: "policy-decision" })
    .filter({ hasText: TOOL }).filter({ hasText: "pending-approval" });
  await expect(event).toBeVisible();
  await retain(activity, "activity-grant-invalidated-event.png");
});

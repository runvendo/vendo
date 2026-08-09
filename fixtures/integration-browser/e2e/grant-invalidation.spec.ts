/** ENG-261 — a real Chromium journey over the composed umbrella proves that
 * descriptor drift both explains the replacement approval and lands in the
 * audit trail a host reads back through `useActivity`. Set
 * ENG261_SCREENSHOT_DIR to retain evidence. */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext, type Locator } from "@playwright/test";

const TOOL = "host_invoices_delete";
// ENG-216 — the approval card aria-label is the humanized title
// (humanizeToolName("host_invoices_delete")); the audit row carries the raw
// slug, so `TOOL` stays for the wire script and the audit-row filter.
const TOOL_LABEL = "Invoices delete";
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

test("descriptor drift explains the replacement approval and the audit event", async ({ page, request }) => {
  await script(request);
  // Keep the standing grant scoped to Bob so this persistent browser backend
  // cannot authorize Ada's independent journey later in the same suite.
  await page.goto(`/?thread=${THREAD}&user=user_bob`);

  const composer = page.getByRole("textbox", { name: /message/i });
  await expect(composer).toBeVisible();
  await composer.fill(`Delete invoice ${FIRST}`);
  await composer.press("Enter");

  const firstApproval = page.getByRole("article", { name: `Approval for ${TOOL_LABEL}` });
  await expect(firstApproval).toBeVisible();
  await firstApproval.getByText("Remember this decision").click();
  await firstApproval.getByRole("checkbox", { name: /Create a reusable grant/i }).check();
  await firstApproval.getByRole("radio", { name: "The whole tool" }).check();
  await firstApproval.getByRole("radio", { name: "Standing" }).check();
  await firstApproval.getByRole("button", { name: "Approve" }).click();
  // Thread-scoped: the morph card clones this text mid-flight (strict mode).
  await expect(page.locator(".fl-msglist").getByText("Deleted the first invoice.")).toBeVisible();

  const drifted = await request.post("/__test/descriptor-drift", { data: { tool: TOOL } });
  expect(drifted.ok()).toBeTruthy();
  const hashes = await drifted.json() as { staleHash: string; currentHash: string };
  expect(hashes.currentHash).not.toBe(hashes.staleHash);

  await composer.fill(`Delete invoice ${SECOND}`);
  await composer.press("Enter");
  const replacement = page.getByRole("article", { name: `Approval for ${TOOL_LABEL}` });
  await expect(replacement.getByRole("note", { name: "Previous permission invalidated" })).toContainText(
    "This tool changed since you approved it on",
  );

  // Reload proves the thread is backed by committed wire/store state: it
  // rehydrates its approval payload from the server, not from memory.
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
    const summaries = await listed.json() as { id: string; title: string; updatedAt: string }[];
    // Newest first: repeat runs against a shared store each mint a fresh thread
    // with this same title, and only the latest one belongs to this run.
    committedThreadId = summaries
      .filter((summary) => summary.title.includes(FIRST))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]?.id;
    expect(committedThreadId).toBeTruthy();
  }).toPass({ timeout: 10_000 });
  await page.goto(`/?thread=${committedThreadId}&user=user_bob`);
  const committedApproval = page.getByRole("article", { name: `Approval for ${TOOL_LABEL}` });
  await expect(committedApproval.getByRole("note", { name: "Previous permission invalidated" })).toBeVisible();
  await retain(committedApproval, "approval-card-invalidated-grant.png");

  // The other half of ENG-261: the invalidated grant is not only explained on
  // the card, it is written to the audit trail and readable back through the
  // SAME wire route `useActivity` serves a host from. Read it through the real
  // route — no stub on either side of the seam.
  await expect(async () => {
    const listed = await request.get("/api/vendo/activity", {
      headers: { "x-vendo-test-user": "user_bob" },
    });
    expect(listed.ok()).toBeTruthy();
    const events = await listed.json() as { kind: string; tool?: string; outcome?: string }[];
    expect(events.some((event) =>
      event.kind === "policy-decision"
      && event.tool === TOOL
      && event.outcome === "pending-approval")).toBe(true);
  }).toPass({ timeout: 10_000 });
});

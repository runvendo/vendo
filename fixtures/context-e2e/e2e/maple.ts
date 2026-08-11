import { expect, type Page } from "@playwright/test";

/**
 * The handles this suite drives Maple by, in one place.
 *
 * Everything here is the SHIPPED surface: the branded launcher demo-bank mounts
 * (`examples/demo-bank/src/components/vendo/VendoLayer.tsx`), the composer and
 * transcript from `@vendoai/ui` (`packages/ui/src/chrome/thread/*`), and the
 * activity ledger the wire already serves (`packages/vendo/src/wire/misc.ts`
 * `GET /activity`). No test-only hooks were added to make this suite possible —
 * the one seam it needed is the harness switch in `proof-harness.ts`.
 */

/** Gate on a PLAUSIBLE key, not merely a set one: a placeholder slot would
 *  otherwise run and fail at the first model call instead of skipping. */
const apiKey = process.env.ANTHROPIC_API_KEY;
export const hasRealKey = typeof apiKey === "string" && apiKey.startsWith("sk-");
export const NO_KEY = "ANTHROPIC_API_KEY absent or placeholder — the whole-chain context proof is env-gated";

/**
 * One turn's allowance.
 *
 * A turn here can be a 25k-token message, a summarizer pass and a multi-step
 * reply on a real seat, so this is minutes. Each spec sets its own timeout to
 * the sum of its turns plus boot slack: the TEST timeout stays the hang
 * detector, and no inner wait is a second, invisible speed limit.
 */
export const TURN_MS = 300_000;

export const MAPLE = "/maple";

/** Maple is mounted at a basePath, so every URL this suite names carries it. */
export const url = (path: string): string => `${MAPLE}${path}`;

/** One audit row as the wire serves it (`packages/harnesses/src/runtime.ts`
 *  `reportRun`): a `run` row is the resident's own spend, a row carrying
 *  `subagent` is one hire's. */
export interface RunRow {
  id: string;
  at: string;
  kind: string;
  detail?: {
    harness?: string;
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    subagent?: { purpose: string; skill?: string; usage?: { inputTokens: number; outputTokens: number } };
    error?: { message: string; code?: string };
  };
}

export type Usage = NonNullable<NonNullable<RunRow["detail"]>["usage"]>;

/**
 * The whole prompt the provider billed for, summed over the turn's steps.
 *
 * `inputTokens` ALREADY contains the cached halves — measured on this suite's
 * own first live run, where a turn reported 19,966 input against 9,417 cache
 * reads and 10,545 cache writes. That is the same ground truth S2's hybrid
 * estimate stands on, so adding the parts back would double-count the prompt.
 */
export const promptTokens = (usage: Usage): number => usage.inputTokens;

/** How much of the turn's prompt the provider served from cache. */
export const cachedShare = (usage: Usage): number =>
  usage.inputTokens === 0 ? 0 : (usage.cacheReadTokens ?? 0) / usage.inputTokens;

/** The audit ledger for the signed-in principal, newest first. `page.request`
 *  carries the page's own session cookie, so this is the same reader the
 *  activity panel uses. */
export async function ledger(page: Page): Promise<RunRow[]> {
  const response = await page.request.get(url("/api/vendo/activity?limit=100"));
  expect(response.ok(), `GET /api/vendo/activity failed: ${response.status()}`).toBe(true);
  return (await response.json()) as RunRow[];
}

/** The rows this spec's turns added, oldest first. */
export async function newRunsSince(page: Page, seen: ReadonlySet<string>): Promise<RunRow[]> {
  const rows = await ledger(page);
  return rows.filter((row) => row.kind === "run" && !seen.has(row.id)).reverse();
}

export async function ledgerIds(page: Page): Promise<Set<string>> {
  return new Set((await ledger(page)).map((row) => row.id));
}

/** Maple's home page with the agent open on an EMPTY thread. `DEMO_AUTOLOGIN`
 *  mints the session, so there is no login form to drive. */
export async function openFreshChat(page: Page): Promise<void> {
  await page.goto(url("/"));
  await page.locator('button.fl-launcher[aria-label="Ask Maple"]').click();
  await expect(page.locator("#vendo-overlay-dialog")).toBeVisible();
  // Threads are per-subject and survive a browser context, so a spec that
  // inherited one starts over rather than inheriting its context too.
  const startOver = page.locator('button[aria-label="New conversation"]');
  if (await startOver.isVisible()) await startOver.click();
  await expect(page.locator('textarea[aria-label="Message"]')).toBeVisible();
}

/**
 * Send one message and wait for the turn to finish.
 *
 * `aria-busy` on the transcript log is the shipped signal
 * (`packages/ui/src/chrome/thread/message-list.tsx`): it goes true the moment
 * the turn is submitted and false when the thread reaches `ready` or `error`.
 * Waiting for the rise first is what stops a stale `false` from reading as a
 * finished turn.
 */
export async function send(page: Page, text: string): Promise<void> {
  await page.locator('textarea[aria-label="Message"]').fill(text);
  await page.locator('button.fl-send[aria-label="Send"]').click();
  const log = page.locator("div.fl-msglist");
  await expect(log).toHaveAttribute("aria-busy", "true", { timeout: TURN_MS });
  await expect(log).toHaveAttribute("aria-busy", "false", { timeout: TURN_MS });
}

/** The newest assistant reply, scoped to the CONVERSATION. Tool identifiers
 *  legitimately appear in the activity panel; this is the surface where they
 *  must not. */
export async function lastReply(page: Page): Promise<string> {
  const replies = page.locator('div.fl-msglist article[data-role="assistant"]');
  const text = await replies.last().innerText();
  expect(text.trim().length, "the assistant replied with nothing").toBeGreaterThan(0);
  return text;
}

/** Neither the banner beside the composer nor the in-thread turn-error part.
 *  Both are the user-visible "this did not finish", and a silent recovery means
 *  neither one exists. */
export async function expectNoTurnError(page: Page): Promise<void> {
  await expect(page.locator("div.fl-error")).toHaveCount(0);
  await expect(page.locator("[data-vendo-turn-error]")).toHaveCount(0);
}

/** A page of filler that reads like something a Maple customer would paste, and
 *  carries none of the identifiers a recall assertion looks for. Sized in
 *  CHARACTERS because the estimate this suite is pushing against is chars/4
 *  (`packages/harnesses/src/vendo/compaction.ts`). */
export function ledgerPaste(chars: number, seed: string): string {
  const merchants = [
    "BRIGHTLEAF GROCERS", "NORTHGATE FUEL", "CEDAR LANE PHARMACY", "HARBOR TRANSIT",
    "PINEHURST HARDWARE", "WESTBROOK CAFE", "STILLWATER UTILITIES", "ORCHARD BOOKS",
  ];
  const lines: string[] = [`Statement export ${seed} — please just acknowledge, do not use any tools.`];
  let total = lines[0]!.length;
  for (let index = 0; total < chars; index += 1) {
    const day = String((index % 28) + 1).padStart(2, "0");
    const merchant = merchants[index % merchants.length]!;
    const cents = String((index * 37) % 100).padStart(2, "0");
    const line = `2026-03-${day}  CARD PURCHASE  ${merchant} #${1000 + (index % 900)}  -$${20 + (index % 300)}.${cents}  posted`;
    lines.push(line);
    total += line.length + 1;
  }
  lines.push("Reply with the single word: logged.");
  return lines.join("\n");
}

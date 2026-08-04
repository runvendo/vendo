import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * H15, measured in a real browser: a host that mounts THREE attention surfaces
 * must spend ONE poller's worth of `GET /approvals`, not three.
 *
 * The `/attention-surfaces` scenario is the realistic host — the center page
 * (its waiting strip + the rail's needs-you section) beside the overlay
 * launcher, three surfaces reading pending asks at 5s each. Before the shared
 * feed (`hooks/approvals-feed.ts`) that was 3 pollers × 12 ticks = ~36 requests
 * a minute, forever.
 *
 * TWO tests, because eventual consistency is NOT the invariant. Three
 * independent pollers also agree on the count eventually; only a REQUEST COUNT
 * can tell the two apart. The first test counts, runs in CI, and is the gate.
 * The second is the 60-second trace for the record, kept env-gated.
 */

/** Every surface's cadence (launcher-status, waiting-queue, rail needs-you). */
const CADENCE_MS = 5_000;
const SURFACES = 3;
const TRACE = new URL("../../../docs/superpowers/evidence/2026-08-03-ui-redesign/postcheck2-gate/", import.meta.url).pathname;

/** Count `GET /approvals` from now until the returned reader is called. */
function countApprovalPolls(page: Page): { at: number[]; since: number } {
  const at: number[] = [];
  const since = Date.now();
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    if (new URL(request.url()).pathname === "/api/vendo/approvals") at.push(Date.now() - since);
  });
  return { at, since };
}

async function mountAllThree(page: Page): Promise<void> {
  await openScenario(page, "attention-surfaces");
  await expect(page.getByRole("region", { name: /Needs you — 1 waiting/ })).toBeVisible();
  await expect(page.getByText("Waiting on you · 1")).toBeVisible();
  await expect(page.getByRole("button", { name: /AI agent/ })).toBeVisible();
}

/**
 * The CI gate. Deterministic and ~20s: the mount burst plus three real ticks.
 *
 * Independent pollers are distinguishable from the very first frame — each one
 * fetches on mount — so the mount burst alone separates 1 from 3, and the ticks
 * confirm the cadence did not silently multiply afterwards.
 */
test("three attention surfaces spend ONE poller's worth of requests", async ({ page }) => {
  const TICKS = 3;
  test.setTimeout(CADENCE_MS * TICKS + 60_000);

  const polls = countApprovalPolls(page);
  await mountAllThree(page);

  // The mount burst: one shared feed fetches once no matter how many surfaces
  // subscribe. Three independent `useResource`s fetch three times.
  await page.waitForTimeout(1_500);
  const onMount = polls.at.length;
  expect(onMount, `mount burst was ${onMount} requests for ${SURFACES} surfaces`).toBe(1);

  // …and it really is polling. A dead poller is also "few requests", so the
  // count must GROW by exactly one per tick.
  await page.waitForTimeout(CADENCE_MS * TICKS + CADENCE_MS / 2);
  const total = polls.at.length;
  const perTick = (total - onMount) / TICKS;
  expect(
    perTick,
    `${total} requests over ${TICKS} ticks with ${SURFACES} surfaces mounted (offsets ms: ${polls.at.join(", ")})`,
  ).toBeGreaterThanOrEqual(0.9);
  expect(perTick, `${total} requests over ${TICKS} ticks — ${SURFACES} pollers would give ~${SURFACES}/tick`)
    .toBeLessThanOrEqual(1.34);
});

/** The 60-second trace for the evidence tree. Not a gate — the test above is. */
test("the 60-second poller trace", async ({ page }) => {
  test.skip(process.env.VENDO_POLLER_PROOF !== "1", "60-second measurement — run it explicitly for the trace");
  const WINDOW_MS = 60_000;
  test.setTimeout(WINDOW_MS + 60_000);

  const polls = countApprovalPolls(page);
  await mountAllThree(page);
  await page.waitForTimeout(WINDOW_MS);

  const ticks = WINDOW_MS / CADENCE_MS;
  const perSurface = ticks + 1;
  await mkdir(TRACE, { recursive: true });
  await writeFile(
    `${TRACE}approvals-poller-trace.txt`,
    [
      "GET /approvals over 60s — /attention-surfaces (center page + overlay launcher)",
      `surfaces mounted: ${SURFACES} (launcher badge, waiting strip, rail needs-you) @ ${CADENCE_MS}ms each`,
      `one poller costs:  ~${perSurface} requests`,
      `three pollers cost: ~${perSurface * SURFACES} requests (the behaviour this round replaced)`,
      `measured:           ${polls.at.length} requests`,
      "",
      `request offsets (ms): ${polls.at.join(", ")}`,
      "",
    ].join("\n"),
    "utf8",
  );

  expect(polls.at.length).toBeLessThanOrEqual(perSurface + 2);
  expect(polls.at.length).toBeGreaterThanOrEqual(ticks - 2);
});

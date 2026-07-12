import { expect, test } from "@playwright/test";

/**
 * LIVE, key-gated (testing doctrine: live tests exist but are env-gated; CI runs
 * deterministic doubles). Exercises the real `realtimeVoiceDriver` against OpenAI
 * Realtime over WebRTC — the one surface in this block that a double cannot prove:
 * a real ephemeral credential, a real peer connection, a real data channel, and
 * the provider's real event stream flowing through the driver's mapper into
 * `useVoice` state and the `VendoStage` transcript.
 *
 * Run:  OPENAI_API_KEY=sk-… pnpm --filter @vendoai/ui exec playwright test e2e/live-voice.spec.ts
 * The mic is Chromium's fake device (see playwright.config.ts launchOptions).
 */
const apiKey = process.env.OPENAI_API_KEY;

test.skip(!apiKey, "OPENAI_API_KEY not set — live realtime voice smoke is env-gated");

test("live: the realtime driver connects, opens its data channel, and reaches listening", async ({ page }) => {
  test.setTimeout(90_000);

  // The harness scenario reads the ephemeral credential the host backend would
  // mint; app code never sees the standing key (the driver takes getSession()).
  const session = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session: { type: "realtime", model: "gpt-realtime" } }),
  });
  expect(session.ok, `minting the ephemeral credential failed: ${session.status} ${await session.text()}`).toBe(true);
  const { value: clientSecret } = (await session.json()) as { value: string };
  expect(clientSecret, "no ephemeral client secret returned").toBeTruthy();

  await page.goto(`/stage-live#${encodeURIComponent(clientSecret)}`);

  await page.getByRole("button", { name: "Start voice" }).click();

  // connecting → listening: proves getUserMedia, the SDP exchange against the
  // real endpoint, and the data channel opening — none of which a double covers.
  await expect(page.getByRole("status")).toContainText("Voice: connecting");
  await expect(page.getByRole("status")).toContainText("Voice: listening", { timeout: 45_000 });

  await page.getByRole("button", { name: "Stop voice" }).click();
  await expect(page.getByRole("status")).toContainText("Voice: idle");
});

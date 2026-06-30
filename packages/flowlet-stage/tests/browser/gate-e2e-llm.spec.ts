import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import Anthropic from "@anthropic-ai/sdk";
import { validateGeneratedPayload, type GeneratedPayload } from "@flowlet/core";
import { SYSTEM_PROMPT, USER_REQUEST, extractJsonObject } from "./llm-prompt";

// Real end-to-end gate: a live Claude call emits a Flowlet GenUI v1 payload, we
// validate it, then render it in the real sandboxed stage. Skips cleanly with no
// API key so normal CI stays green.
const KEY = process.env.ANTHROPIC_API_KEY;
test.skip(!KEY, "ANTHROPIC_API_KEY not set");

test.setTimeout(60000);

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core"), "utf8");

// The validated, Claude-generated payload — produced once in beforeAll.
let payload: GeneratedPayload;

test.beforeAll(async () => {
  const client = new Anthropic({ apiKey: KEY });

  async function ask(extra?: string): Promise<string> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: USER_REQUEST }];
    if (extra) messages.push({ role: "user", content: extra });
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages,
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  function tryParse(raw: string): { ok: true; payload: GeneratedPayload } | { ok: false; error: string } {
    let obj: unknown;
    try {
      obj = JSON.parse(extractJsonObject(raw));
    } catch (e) {
      return { ok: false, error: `parse failed: ${(e as Error).message}` };
    }
    const result = validateGeneratedPayload(obj);
    if (!result.ok) return { ok: false, error: `${result.error.code}: ${result.error.message}` };
    return { ok: true, payload: result.payload };
  }

  // First attempt.
  const raw1 = await ask();
  const first = tryParse(raw1);
  if (first.ok) {
    payload = first.payload;
    return;
  }

  // One retry: tell the model exactly what was wrong and ask it to fix.
  const raw2 = await ask(
    `Your previous output was invalid: ${first.error}. Output ONLY a corrected JSON object that conforms to the Flowlet GenUI v1 shape and uses only the allowed components.`,
  );
  const second = tryParse(raw2);
  if (!second.ok) {
    throw new Error(
      `Claude failed to emit a valid Flowlet GenUI v1 payload after one retry.\n` +
        `First error: ${first.error}\nRetry error: ${second.error}\n` +
        `Raw first output:\n${raw1}\nRaw retry output:\n${raw2}`,
    );
  }
  payload = second.payload;
});

test("gate e2e: a live Claude-generated GenUI v1 payload validates and renders in the real stage", async ({
  page,
}) => {
  // Inject the validated payload BEFORE navigation so the fixture's e2e case
  // can build a session from it on runtime ready.
  await page.addInitScript((p) => {
    (window as any).__e2ePayload = p;
  }, payload);

  await page.goto("/fixtures/host.html?case=e2e");

  // Host-side resolution must have succeeded (no validation-failure marker).
  await expect(page.locator("#e2e-error")).toHaveCount(0);

  const frame = page.frameLocator("#flowlet-stage");

  // Robust assertion (LLM output varies): the frame rendered SOMETHING real —
  // a prewired primitive OR the host Card heading.
  await expect(async () => {
    const primitives = await frame.locator("[data-primitive]").count();
    const cards = await frame.locator('[data-testid="host-card"]').count();
    expect(primitives + cards).toBeGreaterThan(0);
  }).toPass({ timeout: 10000 });

  // No unknown-component placeholders — every component name resolved.
  await expect(frame.locator("[data-error]")).toHaveCount(0);

  // a11y: no serious/critical violations in the sandbox frame.
  const sandboxFrame = page.frames().find((f) => f !== page.mainFrame());
  if (!sandboxFrame) throw new Error("Could not find sandbox frame");
  const results = await sandboxFrame.evaluate(async (src) => {
    // eslint-disable-next-line no-eval
    (0, eval)(src); // defines window.axe
    return await (window as any).axe.run(document, {
      runOnly: ["wcag2a", "wcag2aa"],
      rules: { "color-contrast": { enabled: false } },
    });
  }, axeSource);

  const blocking = (results as any).violations.filter(
    (v: any) => v.impact === "critical" || v.impact === "serious",
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toHaveLength(0);
});

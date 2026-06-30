import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core"), "utf8");

test("gate 7: a self-contained stage has no critical internal a11y violations", async ({
  page,
}) => {
  await page.goto("/fixtures/host.html?case=action"); // tree with heading, text, and a button
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.getByTestId("card-btn")).toBeVisible(); // ensure content mounted

  // Find the sandbox frame object (srcdoc iframe). CDP evaluate bypasses CSP.
  const sandboxFrame = page.frames().find((f) => f !== page.mainFrame());
  if (!sandboxFrame) throw new Error("Could not find sandbox frame");

  // Inject axe-core source into the sandbox document via CDP and run it.
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

  console.log(
    "A11Y violations (color-contrast excluded from scan):",
    JSON.stringify(
      (results as any).violations.map((v: any) => ({ id: v.id, impact: v.impact })),
      null,
      2,
    ),
  );

  // Fail only on blocking structural issues — not demo-content color choices.
  expect(blocking, JSON.stringify(blocking, null, 2)).toHaveLength(0);
});

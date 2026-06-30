import { test, expect } from "@playwright/test";

test(
  "gate 6 (strengthened): iframe height tracks content and grows when a ui/update adds taller content",
  async ({ page }) => {
    await page.goto("/fixtures/host.html?case=card");
    const iframe = page.locator("#flowlet-stage");

    // Wait for initial render and confirm iframe has non-trivial height.
    const frame = page.frameLocator("#flowlet-stage");
    await expect(frame.getByRole("heading", { name: "Hello" })).toBeVisible();
    await expect
      .poll(async () => Math.round((await iframe.boundingBox())!.height))
      .toBeGreaterThan(40);

    const h1 = (await iframe.boundingBox())!.height;

    // Drive a ui/update that replaces the card with much taller content.
    await page.evaluate(async () => {
      await (window as any).__controller.update({
        replace: {
          nodeId: "c1",
          node: {
            id: "c1",
            kind: "component",
            source: "host",
            name: "Card",
            props: {
              title: "Tall",
              body: Array(30).fill("Lorem ipsum dolor sit amet consectetur adipiscing elit.").join(" "),
            },
          },
        },
      });
    });

    // Assert the iframe height grew after the update.
    await expect
      .poll(async () => (await iframe.boundingBox())!.height)
      .toBeGreaterThan(h1 + 50);

    // Assert stability: no oscillation.
    const h2 = (await iframe.boundingBox())!.height;
    await page.waitForTimeout(300);
    const h3 = (await iframe.boundingBox())!.height;
    expect(Math.abs(h2 - h3)).toBeLessThan(2);
  },
);

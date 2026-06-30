import { test, expect } from "@playwright/test";

/**
 * Gate: shared React via ESM artifact + import map.
 *
 * Two externalized host bundles (same source, different blob URLs) must:
 *   (a) Both render correctly.
 *   (b) Share ONE React instance — the shim's load counter stays at 1.
 *
 * Mechanism:
 *   - createStage() injects a sync script before the module runtime that
 *     creates a blob: URL for the Flowlet React shim and registers it via
 *     <script type="importmap">.
 *   - Host bundles are built with React externalized; their `import "react"`
 *     resolves to the shim blob via the importmap (module-cache hit on reuse).
 *   - window.__reactShimLoadCount is incremented once by the shim module.
 *     A second bundle import resolves "react" from cache → count stays 1.
 */
test("gate shared-react: two externalized bundles share one React via import map", async ({
  page,
}) => {
  await page.goto("/fixtures/host.html?case=shared-react");
  const frame = page.frameLocator("#flowlet-stage");

  // (a) First externalized bundle renders a Card correctly.
  await expect(frame.getByTestId("host-card")).toBeVisible({ timeout: 8000 });
  await expect(page.locator("#init-ack")).toHaveText("initialized");

  // Get the actual Frame object (not FrameLocator) to call evaluate().
  // The sandbox iframe is the only non-main frame on the page.
  const sandboxFrame = page.frames().find((f) => f !== page.mainFrame());
  if (!sandboxFrame) throw new Error("Could not find sandbox frame");

  // Shared-React setup ran: the importmap blob URL is set in the sandbox.
  const hasReactUrl = await sandboxFrame.evaluate(
    () => !!(globalThis as any).__FLOWLET_REACT_URL,
  );
  expect(hasReactUrl).toBe(true);

  // Only ONE React shim load after the first bundle.
  const count1 = await sandboxFrame.evaluate(
    () => (globalThis as any).__reactShimLoadCount ?? -1,
  );
  expect(count1).toBe(1);

  // (b) Re-initialize with a SECOND externalized bundle blob (same source → new blob URL).
  //     Its `import "react"` resolves to the already-cached shim blob.
  await page.evaluate(async () => {
    const controller = (window as any).__controller;
    const src = await fetch("/host-bundle-ext.js").then((r: Response) => r.text());
    await controller.initialize({
      theme: {
        "--brand-primary": "#00aa77",
        "--brand-surface": "#fff",
        "--brand-text": "#111",
      },
      state: {},
      bundleSource: src,
      tree: {
        id: "c2",
        kind: "component",
        source: "host",
        name: "Card",
        props: { title: "Bundle2", body: "shared react" },
      },
    });
  });

  // Second bundle rendered correctly.
  await expect(frame.getByRole("heading", { name: "Bundle2" })).toBeVisible({ timeout: 8000 });

  // React shim is STILL loaded exactly once — the importmap module cache was hit.
  const count2 = await sandboxFrame.evaluate(
    () => (globalThis as any).__reactShimLoadCount ?? -1,
  );
  expect(count2).toBe(1);
});

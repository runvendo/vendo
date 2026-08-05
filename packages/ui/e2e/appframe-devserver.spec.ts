import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createProbe } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Frame, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { screenshotPath } from "./helpers.js";

/**
 * Blueprint §10.2 point 2 — "live preview for coded builds via the TEMPLATE'S OWN
 * DEV SERVER (HMR). No bespoke save→rebuild→reload protocol."
 *
 * This is the proof that the second sentence needs no code: the frame the product
 * already ships (`AppFrame` → `HttpFrame`, an `{ kind: "http", url }` surface)
 * renders a REAL Vite dev server, and an edit on disk repaints the frame through
 * Vite's own HMR channel with no reload — so there is nothing for us to build
 * between "the agent wrote a file" and "the person sees it".
 *
 * The dev server is genuine, not a static fixture: Vite's Node API, its HMR
 * WebSocket, its module graph. It is created and closed inside this file, so the
 * suite never leaves a listener behind.
 */

// Motion evidence: a screenshot pair cannot show that the repaint happened in
// place. The recording can.
test.use({ video: "on" });

/** A minimal Vite app whose headline lives in an HMR-accepted dependency. */
const indexHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Preview app</title></head>
  <body style="font: 16px/1.5 system-ui; margin: 24px">
    <!-- Stamped ONCE per document load. If HMR were secretly a reload, this
         changes — which is exactly what the test asserts it does not. -->
    <script>window.__bootId = Math.random().toString(36).slice(2);</script>
    <h1 id="headline">booting…</h1>
    <script type="module" src="/main.js"></script>
  </body>
</html>
`;

const mainJs = `import { headline } from "./headline.js";

const paint = (text) => { document.querySelector("#headline").textContent = text; };
paint(headline);

if (import.meta.hot) {
  import.meta.hot.accept("./headline.js", (next) => { if (next) paint(next.headline); });
}
`;

const headlineJs = (text: string) => `export const headline = ${JSON.stringify(text)};\n`;

/**
 * A free port, reserved the same way `playwright.config.ts` reserves the
 * harness's — vite normalizes `port: 0` to its default 5173 and then tells the
 * HMR client that number, so "let the OS pick" is not expressible here and a
 * fixed port would race every parallel worktree.
 */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createProbe();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** The dev server's frame, by the src it was given. */
function previewFrame(page: Page, url: string): Frame {
  const frame = page.frames().find((candidate) => candidate.url().startsWith(url));
  if (frame === undefined) throw new Error(`no frame is serving ${url}`);
  return frame;
}

test("the existing http frame renders a live dev server, and HMR repaints it without a reload", async ({ page }) => {
  // realpath, not `tmpdir()` raw: on macOS /var/folders is a symlink to
  // /private/var/folders, so the watcher reports the REAL path while vite's root
  // stays the symlinked one — the changed file then looks like it lives outside
  // the project and no module matches it. Measured: no hmr update at all.
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "vendo-preview-app-"));
  writeFileSync(path.join(root, "index.html"), indexHtml);
  writeFileSync(path.join(root, "main.js"), mainJs);
  writeFileSync(path.join(root, "headline.js"), headlineJs("BEFORE THE EDIT"));

  let server: ViteDevServer | undefined;
  try {
    server = await createServer({
      configFile: false,
      root,
      server: { host: "127.0.0.1", port: await freePort(), strictPort: true },
      logLevel: "warn",
    });
    await server.listen();
    const devUrl = server.resolvedUrls?.local[0];
    expect(devUrl, "the vite dev server must report a local url").toBeTruthy();
    const url = devUrl!.replace(/\/$/, "");

    await page.goto(`/appframe-devserver#${encodeURIComponent(url)}`);
    const frameElement = page.locator('section[aria-label="Live dev server preview"] iframe');
    await expect(frameElement).toHaveAttribute("src", url);

    // The dev server is a different ORIGIN from the harness page (a different
    // port is a different origin), so `httpFrameSandbox` grants the frame its
    // OWN origin — which is what lets Vite's HMR client open its WebSocket.
    // A same-origin preview url would run opaque and could not.
    expect(await frameElement.getAttribute("sandbox")).toContain("allow-same-origin");

    const framed = page.frameLocator('section[aria-label="Live dev server preview"] iframe');
    await expect(framed.locator("#headline")).toHaveText("BEFORE THE EDIT");
    const bootId = await previewFrame(page, url).evaluate(() => (window as unknown as { __bootId: string }).__bootId);
    expect(bootId).toBeTruthy();
    await page.screenshot({ path: screenshotPath("appframe-devserver-before"), fullPage: false });

    // THE EDIT — the only thing a coded build does: write a file.
    writeFileSync(path.join(root, "headline.js"), headlineJs("AFTER THE EDIT — HMR, NO RELOAD"));

    await expect(framed.locator("#headline")).toHaveText("AFTER THE EDIT — HMR, NO RELOAD");
    await page.screenshot({ path: screenshotPath("appframe-devserver-after-hmr"), fullPage: false });

    // The document never reloaded: same boot id, new content. That is HMR, and it
    // is why no save→rebuild→reload protocol of ours is needed.
    const afterBootId = await previewFrame(page, url).evaluate(() => (window as unknown as { __bootId: string }).__bootId);
    expect(afterBootId).toBe(bootId);
  } finally {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

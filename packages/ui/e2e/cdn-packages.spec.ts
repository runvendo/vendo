import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { JAIL_PACKAGE_CDN_ORIGIN } from "@vendoai/core";
import { jailFrame, openScenario } from "./helpers.js";

/**
 * The preview venue's CDN package loading, proven against the REAL bytes
 * `vendo sync` captured for Maple's `MapleSpendingDonut` — a component that
 * imports `recharts` and, before this lane, could only be skipped.
 *
 * Nothing here supplies the consumer with anything the capture did not ask for:
 * the record, its module blobs, its sample seed and its package pins are read
 * off disk and inflated exactly the way the console does, then handed to the
 * shipped renderer in a real Chromium. A harness that hands the jail a package
 * the record never declared cannot detect a consumer that lacks it, which is
 * how a previous lane reported "4 of 6 draw" while the browser drew one.
 */
const CAPTURE_DIR = new URL("../../../examples/demo-bank/.vendo/components/", import.meta.url).pathname;

interface CapturedModule { source: string; imports?: Record<string, string> }

interface CapturedRecord {
  name: string;
  export?: string;
  entry?: string;
  modules?: Record<string, string>;
  requires?: string[];
  packages?: Record<string, string>;
  sampleProps?: Record<string, unknown>;
  skipped?: { reason: string; detail: string };
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const blob = (ref: string): CapturedModule => readJson<CapturedModule>(`${CAPTURE_DIR}modules/${ref}.json`);

/** The console's `inflateHostComponent`, in the words of this repo's own format:
 *  refs in, one `JailFurnishing` plus the entry source out. */
function inflate(name: string) {
  const record = readJson<CapturedRecord>(`${CAPTURE_DIR}${name}.json`);
  expect(record.skipped, `${name} must be captured, not skipped, for this proof to mean anything`).toBeUndefined();
  expect(record.packages, `${name} must declare its CDN package pins`).toBeDefined();
  const entry = blob(record.entry!);
  const subSources: Record<string, CapturedModule> = {};
  for (const [id, ref] of Object.entries(record.modules ?? {})) {
    const sub = blob(ref);
    subSources[id] = { source: sub.source, imports: sub.imports ?? {} };
  }
  const source = record.export === undefined || record.export === "default"
    ? entry.source
    : `${entry.source}\nexport { ${record.export} as default };\n`;
  return { record, source, furnishing: {
    sourceImports: entry.imports ?? {},
    subSources,
    ...(record.sampleProps === undefined ? {} : { sampleProps: record.sampleProps }),
    ...(record.packages === undefined ? {} : { packages: record.packages }),
  } };
}

/** The payload shape the console's `planPreview` produces: the host node is
 *  grafted in as a generated one, and `streaming` is permanently on. */
function previewPayload(name: string, options: { packages: boolean }): Record<string, unknown> {
  const { source, furnishing } = inflate(name);
  const { packages, ...withoutPackages } = furnishing;
  return {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: [name] },
      { id: name, component: name, source: "generated" },
    ],
    components: { [name]: source },
    furnishings: { [name]: options.packages ? furnishing : withoutPackages },
    streaming: true,
  };
}

async function watchFrame(page: Page) {
  const cdnRequests: string[] = [];
  const cdnHeaders: Array<Record<string, string>> = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(JAIL_PACKAGE_CDN_ORIGIN)) return;
    cdnRequests.push(request.url());
    void request.allHeaders().then((headers) => cdnHeaders.push(headers));
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { cdnRequests, cdnHeaders, consoleErrors, pageErrors };
}

const inject = (page: Page, payload: Record<string, unknown>) =>
  page.addInitScript((value) => {
    (globalThis as { __VENDO_HARNESS_PAYLOAD__?: unknown }).__VENDO_HARNESS_PAYLOAD__ = value;
  }, payload);

/** Every `script-src` the jail actually mounted, read off the live `srcdoc`
 *  attributes (the sandbox has no `allow-same-origin`, so the frame's own
 *  document is unreachable from here — the attribute is the policy). */
async function jailScriptSources(page: Page): Promise<string[]> {
  return page.locator("iframe[srcdoc]").evaluateAll((frames) => frames.flatMap(
    (frame) => (frame as HTMLIFrameElement).srcdoc.match(/script-src [^;"]+/gu) ?? [],
  ));
}

test("a captured host component importing recharts draws a real chart from the pinned CDN", async ({ page }) => {
  const watched = await watchFrame(page);
  await inject(page, previewPayload("MapleSpendingDonut", { packages: true }));
  await openScenario(page, "tree-injected");

  const jail = jailFrame(page, "MapleSpendingDonut");
  // recharts renders an <svg> with one <path> per slice. The seed carries two.
  await expect(jail.locator("svg .recharts-pie-sector path").first()).toBeVisible({ timeout: 20_000 });
  expect(await jail.locator("svg .recharts-pie-sector").count()).toBe(2);
  // The component's own non-chart markup renders too (its centred total label).
  await expect(jail.getByText("Total")).toBeVisible();

  expect(watched.cdnRequests.length, "the pinned CDN must actually have been used").toBeGreaterThan(0);
  const otherOrigins = watched.cdnRequests.filter((url) => !url.startsWith(`${JAIL_PACKAGE_CDN_ORIGIN}/`));
  expect(otherOrigins, "every package request stays on the ONE pinned origin").toEqual([]);
  // Nothing about the host's project may ride along. The jail is an opaque
  // origin, so the browser sends no Referer and no cookies — asserted, because
  // "the CDN never learns whose project this is" is a promise in the docs.
  for (const url of watched.cdnRequests) {
    expect(url).not.toContain("127.0.0.1");
    expect(url).not.toContain("localhost");
  }
  expect(watched.cdnHeaders.length).toBeGreaterThan(0);
  for (const headers of watched.cdnHeaders) {
    expect(headers.referer).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers.origin ?? "null").toBe("null");
  }
  expect(watched.consoleErrors, "no CSP refusals and no console errors").toEqual([]);
  expect(watched.pageErrors).toEqual([]);

  const srcdoc = await page.locator('iframe[title="Generated component: MapleSpendingDonut"]')
    .evaluate((frame) => (frame as HTMLIFrameElement).srcdoc);
  expect(srcdoc).toContain("default-src 'none'");
  expect(srcdoc).toContain("connect-src 'none'");
  expect(srcdoc).toContain(`'unsafe-eval' ${JAIL_PACKAGE_CDN_ORIGIN} data:`);
  expect(srcdoc, "the CDN belongs to script-src and nothing else")
    .not.toContain(`connect-src ${JAIL_PACKAGE_CDN_ORIGIN}`);
  expect(srcdoc).not.toContain("allow-same-origin");
});

test("the production venue asks the CDN for nothing and keeps the network-denied CSP", async ({ page }) => {
  const watched = await watchFrame(page);
  // The real fork shape: `/tree-jail` renders a captured pin furnishing exactly
  // as a remix fork does inside a customer's own page — `attachPinFurnishings`
  // has never had a `packages` field to copy.
  await openScenario(page, "tree-jail");
  await expect(jailFrame(page, "FurnishedPin").getByRole("heading")).toBeVisible();

  const scriptSources = await jailScriptSources(page);
  expect(scriptSources.length, "the fork must actually be jailed").toBeGreaterThan(0);
  for (const directive of scriptSources) {
    // Exact, not shape-matched. This used to compare against a string built from
    // the directive itself (to tolerate the per-mount nonce), which would have
    // accepted `script-src https://evil 'unsafe-eval'` just as happily. With the
    // nonce gone the policy is deterministic, so the assertion can be the policy.
    expect(directive, "no packages means no network source in the policy at all")
      .toBe("script-src 'unsafe-inline' 'unsafe-eval'");
  }
  expect(watched.cdnRequests, "a fork in a customer's page must never reach a CDN").toEqual([]);
});

test("the SAME captured component without package pins reaches no CDN either", async ({ page }) => {
  const watched = await watchFrame(page);
  // One field removed, nothing else: this is what the strip in
  // `stripServerAuthoritativeFields` leaves of a tree that claimed packages.
  await inject(page, previewPayload("MapleSpendingDonut", { packages: false }));
  await openScenario(page, "tree-injected");
  // Its `require("recharts")` throws and the surface degrades — which is exactly
  // why the capture also lists `recharts` in `requires`, so a consumer that
  // cannot supply it says so instead of rendering this.
  await expect(page.locator("[data-form-shape]")).toBeVisible();
  expect(watched.cdnRequests, "no pins means no request, whatever the source imports").toEqual([]);
});

test("a package that will not load shows the honest tile — never a hang on the skeleton", async ({ page }) => {
  const watched = await watchFrame(page);
  // The CDN is unreachable, which is the case a preview must survive legibly.
  await page.route(`${JAIL_PACKAGE_CDN_ORIGIN}/**`, (route) => route.abort());
  await inject(page, previewPayload("MapleSpendingDonut", { packages: true }));
  await openScenario(page, "tree-injected");

  const notice = page.getByRole("note", { name: "Preview unavailable" });
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(notice).toHaveText(/MapleSpendingDonut: could not load recharts@\d/u);
  // `streaming` is permanently on in a preview, so the failure must NOT be
  // swallowed into the forming silhouette (the bug this lane was warned about).
  await expect(page.locator("[data-streaming-component]")).toHaveCount(0);
  expect(watched.pageErrors).toEqual([]);
});

/**
 * The sealed bundle's RENDER seam, end to end through REAL paths.
 *
 * Three halves have to agree about one app: the seal writes content-addressed
 * blobs (`sealBundleBlobs`), the open door names the entry hash the frame should
 * boot (`{kind:"bundle", entry}`), and the wire route serves those bytes wrapped
 * in the document that renders them. A suite that stubbed any of the three could
 * only agree with itself, so everything below goes through the real writer, a
 * real store, and the real `createVendo` handler — no stand-in anywhere.
 *
 * What is really on trial is the CSP, asserted byte for byte: it is the enforcer
 * the whole "sealed bundles need no network" promise rests on, and it is a
 * HEADER rather than a meta tag because `frame-ancestors` only exists there.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealBundleBlobs } from "@vendoai/apps";
import { VENDO_APP_FORMAT, type AppBundle, type AppId, type Principal } from "@vendoai/core";
import { createStore, storeFiles } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';"
  + " img-src data:; font-src data:; frame-ancestors 'self'";

const ADA: Principal = { kind: "user", subject: "user_ada" };
const APP = "app_built" as AppId;
/** A built bundle carries markup in its own strings, and a raw `</script>` in an
 *  inline script ends the script — so the shell has to escape it or the app that
 *  renders a table of HTML snippets ships broken. */
const ENTRY_BYTES = new TextEncoder().encode('const closer = "</script>";\ndocument.title = "built";\n');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(): Promise<{ vendo: Vendo; bundle: AppBundle }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-bundle-route-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  // THE REAL SEAL: the same writer the build door lands a box's output through.
  const bundle = await sealBundleBlobs(
    APP,
    [{ path: "dist/app.js", bytes: ENTRY_BYTES }],
    "dist/app.js",
    storeFiles(store),
  );
  await store.records("vendo_apps").put({
    id: APP,
    data: {
      subject: ADA.subject,
      enabled: true,
      doc: { format: VENDO_APP_FORMAT, id: APP, name: "Built app", ui: "bundle", bundle },
    },
    refs: { subject: ADA.subject },
  });
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async (request) => {
      const subject = request.headers.get("x-test-user");
      return subject === null ? null : { kind: "user", subject };
    },
    store,
  });
  return { vendo, bundle };
}

const get = (vendo: Vendo, path: string, subject?: string): Promise<Response> =>
  vendo.handler(new Request(`http://wire.test/api/vendo${path}`, {
    headers: subject === undefined ? {} : { "x-test-user": subject },
  }));

describe("the sealed bundle's render seam", () => {
  it("opens as a bundle surface and serves those exact bytes inline, behind the CSP", async () => {
    const { vendo, bundle } = await setup();

    // The open door names the hash — which IS the frame's remount key.
    const surface = await (await get(vendo, `/apps/${APP}/open`, ADA.subject)).json();
    expect(surface).toEqual({ kind: "bundle", entry: bundle.entry });

    const response = await get(vendo, `/apps/${APP}/bundle/${bundle.entry}`, ADA.subject);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(CSP);
    expect(response.headers.get("content-type")).toContain("text/html");

    const document_ = await response.text();
    // INLINE, so the frame fetches nothing — `default-src 'none'` blocks every
    // request it could make, including one back for its own script.
    expect(document_).toContain('document.title = "built";');
    expect(document_).not.toContain("<script src");
    // …and the bundle's own `</script>` did not end the script tag early.
    expect(document_.split("</script>")).toHaveLength(2);
  });

  it("lets a data: font face in and still no network out, and bakes no font into the seal", async () => {
    const { vendo, bundle } = await setup();
    const response = await get(vendo, `/apps/${APP}/bundle/${bundle.entry}`, ADA.subject);
    const policy = response.headers.get("content-security-policy") ?? "";

    // Brand fonts are injected AT RENDER as `data:` faces, which `default-src
    // 'none'` blocks outright — so the policy has to name them, and inline is
    // the only spelling it may name. A scheme or an origin here would hand the
    // frame back the network the whole seal rests on not having.
    expect(policy).toContain("font-src data:");
    expect(policy).not.toMatch(/https?:|\/\//u);

    // Nothing font-related is in the sealed bytes: the seal is content, the
    // face is brand, and the two must never meet.
    const document_ = await response.text();
    expect(document_).not.toContain("@font-face");
    expect(document_).not.toContain("font-family");
  });

  it("is viewer-scoped: a stranger gets not-found, never the bytes", async () => {
    const { vendo, bundle } = await setup();
    const response = await get(vendo, `/apps/${APP}/bundle/${bundle.entry}`, "user_bob");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("document.title");
  });

  it("answers not-found for a hash this app never sealed", async () => {
    const { vendo } = await setup();
    const response = await get(vendo, `/apps/${APP}/bundle/${"0".repeat(64)}`, ADA.subject);
    expect(response.status).toBe(404);
  });
});

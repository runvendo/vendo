/**
 * The app's source layout and the checkout/commit seam — contract §3.2.
 *
 * The point of the contract is that the ROW is the truth and a workspace is a
 * working copy of it. So this test refuses to mock either side: an app row lands
 * in a real store, a real `workspaceStore(...).open()` filesystem is written and
 * committed through, `commitApp` diffs it into `doc.source`, and then a SECOND,
 * FRESH workspace is checked out from the row alone and read back. If the producer
 * and the consumer disagree about the layout, the bytes come back wrong or not at
 * all — which is exactly what a stubbed counterparty could never tell us.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  WORKSPACE_INLINE_MAX_BYTES,
  appDocumentSchema,
  sha256Hex,
  type AppDocument,
  type AppId,
  type FilesAdapter,
  type Principal,
  type RunContext,
  type WorkspaceFs,
} from "@vendoai/core";
import { checkoutApp, commitApp, type AppSourceSeam } from "@vendoai/apps";
import { createStore, workspaceStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_source" };
const APP = "app_source_1" as AppId;
const ctx: RunContext = {
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "s1",
};

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-appsource-"));
  const store = createStore({ dataDir });
  await store.ensureSchema();
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** A tiny in-memory blob seam — the SAME `FilesAdapter` shape the workspace rows
 *  spill through, so an oversized source file uses the mechanism that exists. */
function memoryBlobs(): FilesAdapter & { keys(): string[] } {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(key, bytes) {
      blobs.set(key, bytes);
    },
    async get(key) {
      const bytes = blobs.get(key);
      return bytes === undefined ? undefined : { bytes };
    },
    async delete(key) {
      blobs.delete(key);
    },
    keys: () => [...blobs.keys()],
  };
}

/**
 * The store half of the seam, bound over the REAL app row — what composition
 * binds in production. `@vendoai/apps` has no store dependency by design, which
 * is why the seam takes these in rather than importing them.
 */
function seamOver(store: VendoStore, blobs?: FilesAdapter, owner = principal.subject): AppSourceSeam {
  const apps = store.records("vendo_apps");
  const row = async (): Promise<{ subject: string; doc: AppDocument }> => {
    const record = await apps.get(APP);
    if (record === null) throw new Error(`no row for ${APP}`);
    const data = record.data as { subject: string; doc: unknown };
    return { subject: data.subject, doc: appDocumentSchema.parse(data.doc) };
  };
  return {
    requireOwned: async () => (await row()).doc,
    // The row's own subject — the authoritative owner, which is what decides the
    // app's address. Read from the record rather than remembered, exactly as
    // composition does.
    ownerOf: async () => (await row()).subject,
    async update(_appId, mutate) {
      const next = mutate(structuredClone((await row()).doc));
      await apps.put({
        id: APP,
        data: { subject: owner, enabled: false, doc: next },
        refs: { subject: owner },
      });
      return next;
    },
    ...(blobs === undefined ? {} : { blobs }),
  };
}

/** A stored app with a trigger on it — the field §3.2 must carry through
 *  untouched, since automations are out of scope and must not regress. */
async function seedApp(store: VendoStore): Promise<void> {
  const doc: AppDocument = {
    format: VENDO_APP_FORMAT,
    id: APP,
    name: "Spending",
    trigger: { on: { kind: "schedule", cron: "0 9 * * *" }, run: { kind: "agentic", prompt: "send the digest" } },
  } as AppDocument;
  await store.records("vendo_apps").put({
    id: APP,
    data: { subject: principal.subject, enabled: false, doc },
    refs: { subject: principal.subject },
  });
}

/** The honest hash of some text, so a test can lie about ONE field at a time. */
const contentHashOf = (text: string): string => `sha256:${sha256Hex(text)}`;

const openWorkspace = (store: VendoStore, blobs?: FilesAdapter): Promise<WorkspaceFs> =>
  workspaceStore(store, blobs === undefined ? {} : { files: blobs }).open(principal);

describe("app source: checkout and commit (contract §3.2)", () => {
  it("lands changed source in the row, and a fresh checkout brings it back byte for byte", async () => {
    const store = await tempStore();
    await seedApp(store);
    const seam = seamOver(store);

    // The real write path: a workspace write, a real commit, then the diff.
    const writing = await openWorkspace(store);
    await writing.writeFile(`/user/apps/${APP}/src/App.tsx`, "export const App = () => null;\n");
    await writing.writeFile(`/user/apps/${APP}/vendo.json`, '{"name":"Spending"}\n');
    const result = await writing.commit();
    expect(result.status).toBe("ok");
    await commitApp(APP, result.status === "ok" ? result.changed : [], writing, ctx, seam);

    const stored = await seam.requireOwned(APP, ctx);
    expect(Object.keys(stored.source ?? {}).sort()).toEqual(["src/App.tsx", "vendo.json"]);
    expect(stored.source!["src/App.tsx"]!.text).toBe("export const App = () => null;\n");
    expect(stored.source!["src/App.tsx"]!.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(stored.source!["src/App.tsx"]!.bytes).toBe("export const App = () => null;\n".length);
    // The one thing automations are owed: the trigger survives a source commit.
    expect(stored.trigger).toEqual({
      on: { kind: "schedule", cron: "0 9 * * *" },
      run: { kind: "agentic", prompt: "send the digest" },
    });

    // The real read path: a SECOND workspace, opened fresh over the same rows and
    // materialized from the document alone. Nothing carried over from the writer.
    const fresh = await openWorkspace(store);
    await checkoutApp(APP, fresh, ctx, seamOver(store));
    expect(await fresh.readFile(`/user/apps/${APP}/src/App.tsx`)).toBe("export const App = () => null;\n");
    expect(await fresh.readFile(`/user/apps/${APP}/vendo.json`)).toBe('{"name":"Spending"}\n');
  }, 60_000);

  it("spills a file past the inline cap through the workspace's own blob seam", async () => {
    const store = await tempStore();
    await seedApp(store);
    const blobs = memoryBlobs();
    const seam = seamOver(store, blobs);

    const big = "x".repeat(WORKSPACE_INLINE_MAX_BYTES + 1);
    const writing = await openWorkspace(store, blobs);
    await writing.writeFile(`/user/apps/${APP}/src/big.ts`, big);
    const result = await writing.commit();
    await commitApp(APP, result.status === "ok" ? result.changed : [], writing, ctx, seam);

    const stored = await seam.requireOwned(APP, ctx);
    const file = stored.source!["src/big.ts"]!;
    expect(file.text).toBeUndefined();
    expect(file.blobRef).toBeDefined();
    expect(file.bytes).toBe(WORKSPACE_INLINE_MAX_BYTES + 1);
    // The source blob and the WORKSPACE's own row blob are both in here, which is
    // the whole point: one adapter, two callers, no second spill mechanism.
    expect(blobs.keys()).toContain(file.blobRef);
    expect(blobs.keys().some((key) => key.startsWith("wsb_"))).toBe(true);

    // And it comes back out of the blob on checkout, not out of the row.
    const fresh = await openWorkspace(store, blobs);
    await checkoutApp(APP, fresh, ctx, seam);
    expect(await fresh.readFile(`/user/apps/${APP}/src/big.ts`)).toBe(big);
  }, 60_000);

  it("drops a deleted file and leaves the two hot paths to the render seam", async () => {
    const store = await tempStore();
    await seedApp(store);
    const seam = seamOver(store);

    const writing = await openWorkspace(store);
    await writing.writeFile(`/user/apps/${APP}/src/gone.ts`, "temporary\n");
    await writing.writeFile(`/user/apps/${APP}/app.vendo`, `<App name="Spending"/>`);
    const first = await writing.commit();
    await commitApp(APP, first.status === "ok" ? first.changed : [], writing, ctx, seam);
    // `app.vendo` is the render seam's file: it becomes the app through that seam,
    // and duplicating it into `source` would be two owners again.
    expect(Object.keys((await seam.requireOwned(APP, ctx)).source ?? {})).toEqual(["src/gone.ts"]);

    await writing.rm(`/user/apps/${APP}/src/gone.ts`);
    const second = await writing.commit();
    await commitApp(APP, [`/user/apps/${APP}/src/gone.ts`, ...(second.status === "ok" ? second.changed : [])], writing, ctx, seam);
    expect((await seam.requireOwned(APP, ctx)).source).toBeUndefined();
  }, 60_000);

  /**
   * The AMBIGUOUS case, and the one that makes "first writable candidate" wrong:
   * an ORG-OWNED app whose editor can also write their own `/user` mount. Both
   * addresses answer `canCommit` yes, so permission cannot pick between them —
   * only the app's OWNERSHIP can. Get it wrong and the projection lands in the
   * caller's personal mount, `commitApp` derives that same wrong prefix, and
   * every edit made under `/orgs/<org>/apps/<appId>` is filtered out and
   * silently dropped.
   */
  it("materializes an ORG-owned app in its ORG mount, even when the personal mount is writable too", async () => {
    const store = await tempStore();
    const ORG = "maple";
    const membership = { org: ORG, display: "Maple Bank", teams: ["support"], admin: true };
    const orgCtx: RunContext = { ...ctx, memberships: [membership] };
    // Owned by the ORG: the row's subject IS the org (build contract §9.7 —
    // owner and path prefix always travel together).
    await store.records("vendo_apps").put({
      id: APP,
      data: { subject: ORG, enabled: false, doc: { format: VENDO_APP_FORMAT, id: APP, name: "Team spending" } },
      refs: { subject: ORG },
    });
    const seam = seamOver(store, undefined, ORG);

    const workspace = await workspaceStore(store).open(principal, { memberships: [membership] });
    // Both addresses are genuinely writable — this is what makes the case
    // ambiguous rather than hypothetical.
    expect(await workspace.canCommit(`/user/apps/${APP}/app.vendo`)).toBe(true);
    expect(await workspace.canCommit(`/orgs/${ORG}/apps/${APP}/app.vendo`)).toBe(true);

    // The harness edits the app where the app actually lives.
    await workspace.writeFile(`/orgs/${ORG}/apps/${APP}/src/App.tsx`, "export const App = () => null;\n");
    const result = await workspace.commit();
    expect(result.status).toBe("ok");
    await commitApp(APP, result.status === "ok" ? result.changed : [], workspace, orgCtx, seam);

    // The org edit LANDED — the whole point. Keyed by its path inside the app
    // directory, with no mount prefix left on it.
    const stored = await seam.requireOwned(APP, orgCtx);
    expect(Object.keys(stored.source ?? {})).toEqual(["src/App.tsx"]);

    // And a fresh checkout puts it back at the ORG address, not the personal one.
    const fresh = await workspaceStore(store).open(principal, { memberships: [membership] });
    await checkoutApp(APP, fresh, orgCtx, seam);
    expect(await fresh.readFile(`/orgs/${ORG}/apps/${APP}/src/App.tsx`)).toBe("export const App = () => null;\n");
    await expect(fresh.readFile(`/user/apps/${APP}/src/App.tsx`)).rejects.toThrow();
  }, 60_000);

  /**
   * `hash` is the CAS base a commit diffs against, so a row whose metadata
   * contradicts its bytes makes a checkout produce a DIFFERENT app than the one
   * stored — and the whole promise of source-in-the-row is that it cannot. The
   * document validator cannot catch this: it sees field shapes, and for a
   * blob-spilled file it never sees the bytes at all.
   */
  it("refuses to check out content that is not the content its row describes", async () => {
    const store = await tempStore();
    await seedApp(store);
    const blobs = memoryBlobs();
    const seam = seamOver(store, blobs);
    const real = "export const App = () => null;\n";

    // Inline: honest bytes, lying hash.
    await seam.update(APP, (doc) => ({
      ...doc,
      source: { "src/App.tsx": { hash: `sha256:${"0".repeat(64)}`, bytes: real.length, text: real } },
    }), ctx);
    const one = await openWorkspace(store, blobs);
    await expect(checkoutApp(APP, one, ctx, seam)).rejects.toThrow(/hashes to sha256:.* but its row says/);

    // Inline: honest hash, lying length.
    await seam.update(APP, (doc) => ({
      ...doc,
      source: { "src/App.tsx": { hash: `sha256:${"0".repeat(64)}`, bytes: 1, text: real } },
    }), ctx);
    const two = await openWorkspace(store, blobs);
    await expect(checkoutApp(APP, two, ctx, seam)).rejects.toThrow(/is 31 bytes but its row says 1/);

    // Blob-spilled: the bytes exist and are simply not the ones described. This
    // is the arm the validator can never reach.
    await blobs.put("apps/forged", new TextEncoder().encode("something else entirely"));
    await seam.update(APP, (doc) => ({
      ...doc,
      source: { "src/App.tsx": { hash: contentHashOf(real), bytes: real.length, blobRef: "apps/forged" } },
    }), ctx);
    const three = await openWorkspace(store, blobs);
    await expect(checkoutApp(APP, three, ctx, seam)).rejects.toThrow(/but its row says/);

    // Nothing was written on the way to any of those refusals.
    await expect(three.readFile(`/user/apps/${APP}/src/App.tsx`)).rejects.toThrow();
  }, 60_000);

  /**
   * The frozen layout has no way to spell ANOTHER person's personal mount:
   * `/user` is always the caller's own. So resolving a foreign personal app to
   * `/user/apps/<appId>` points at the CALLER's rows while the row it writes back
   * to is someone else's — a caller could stage files in their own workspace and
   * land them on another person's app. `commitApp` is the sharp end: it never
   * calls `requireOwned`, so `canCommit` on a subjectless path was its only gate,
   * and that gate answers about the caller's own mount.
   */
  it("refuses a personal app owned by someone else — both checkout and commit", async () => {
    const store = await tempStore();
    const STRANGER = "user_stranger";
    await store.records("vendo_apps").put({
      id: APP,
      data: {
        subject: STRANGER,
        enabled: false,
        doc: {
          format: VENDO_APP_FORMAT,
          id: APP,
          name: "Their private app",
          source: { "src/Theirs.tsx": { hash: contentHashOf("theirs\n"), bytes: 7, text: "theirs\n" } },
        },
      },
      refs: { subject: STRANGER },
    });
    const seam = seamOver(store, undefined, STRANGER);

    const workspace = await openWorkspace(store);
    // The caller can write their own `/user` mount — which is exactly why
    // permission cannot be the thing that refuses this.
    expect(await workspace.canCommit(`/user/apps/${APP}/app.vendo`)).toBe(true);

    await expect(checkoutApp(APP, workspace, ctx, seam)).rejects.toThrow(/another person/);
    // Nothing of theirs was materialized into this caller's workspace.
    await expect(workspace.readFile(`/user/apps/${APP}/src/Theirs.tsx`)).rejects.toThrow();

    // And the commit half refuses on its own, not because checkout happened to
    // run first: a caller who stages a file at that path directly cannot land it.
    await workspace.writeFile(`/user/apps/${APP}/src/Mine.tsx`, "mine\n");
    const result = await workspace.commit();
    expect(result.status).toBe("ok");
    await expect(
      commitApp(APP, result.status === "ok" ? result.changed : [], workspace, ctx, seam),
    ).rejects.toThrow(/another person/);

    // Their document is untouched — the whole point.
    const theirs = await seam.requireOwned(APP, ctx);
    expect(Object.keys(theirs.source ?? {})).toEqual(["src/Theirs.tsx"]);
  }, 60_000);

  it("refuses a source path that would escape the app's directory", async () => {
    const store = await tempStore();
    await seedApp(store);
    const seam = seamOver(store);
    await seam.update(APP, (doc) => ({
      ...doc,
      source: { "../other/App.tsx": { hash: `sha256:${"0".repeat(64)}`, bytes: 1, text: "x" } },
    }), ctx);
    const fresh = await openWorkspace(store);
    await expect(checkoutApp(APP, fresh, ctx, seam)).rejects.toThrow(/must not contain empty or dot segments/);
  }, 60_000);
});

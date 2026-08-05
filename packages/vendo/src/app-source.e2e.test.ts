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
function seamOver(store: VendoStore, blobs?: FilesAdapter): AppSourceSeam {
  const apps = store.records("vendo_apps");
  const load = async (): Promise<AppDocument> => {
    const record = await apps.get(APP);
    if (record === null) throw new Error(`no row for ${APP}`);
    return appDocumentSchema.parse((record.data as { doc: unknown }).doc);
  };
  return {
    requireOwned: load,
    async update(_appId, mutate) {
      const next = mutate(structuredClone(await load()));
      await apps.put({
        id: APP,
        data: { subject: principal.subject, enabled: false, doc: next },
        refs: { subject: principal.subject },
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

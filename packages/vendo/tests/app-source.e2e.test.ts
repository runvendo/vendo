/**
 * The app's source layout and the commit seam — contract §3.2.
 *
 * The point of the contract is that the ROW is the truth and a workspace is a
 * working copy of it. So this test refuses to mock either side: an app row lands
 * in a real store, a real `workspaceStore(...).open()` filesystem is written and
 * committed through, and `commitApp` diffs it into `doc.source` — the real write
 * path end to end, with the real store answering. If the producer and the store
 * disagree about the layout, the bytes land wrong or not at all, which is exactly
 * what a stubbed counterparty could never tell us.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TRIGGER_ID,
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
import { commitApp, type AppSourceSeam } from "@vendoai/apps";
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

describe("app source: commit (contract §3.2)", () => {
  it("lands changed source in the row, byte for byte", async () => {
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
    // The row was seeded in the PRE-LIST shape on purpose, so this also pins the
    // read normalization — the legacy singular `trigger` comes back as the
    // one-element list under DEFAULT_TRIGGER_ID, and the commit keeps it.
    expect(stored.triggers).toEqual([{
      id: DEFAULT_TRIGGER_ID,
      on: { kind: "schedule", cron: "0 9 * * *" },
      run: { kind: "agentic", prompt: "send the digest" },
    }]);
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
  }, 60_000);

  it("drops a deleted file and leaves the hot path to the render seam", async () => {
    const store = await tempStore();
    await seedApp(store);
    const seam = seamOver(store);

    const writing = await openWorkspace(store);
    await writing.writeFile(`/user/apps/${APP}/src/gone.ts`, "temporary\n");
    await writing.writeFile(`/user/apps/${APP}/app.tsx`, `export default function Spending() { return null; }`);
    const first = await writing.commit();
    await commitApp(APP, first.status === "ok" ? first.changed : [], writing, ctx, seam);
    // `app.tsx` is the render seam's file: it becomes the app through that seam
    // (the gauntlet's own paint stores it), and duplicating it into `source` here
    // would be two owners again — and would store a screen the floor refused.
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
    expect(await workspace.canCommit(`/user/apps/${APP}/app.tsx`)).toBe(true);
    expect(await workspace.canCommit(`/orgs/${ORG}/apps/${APP}/app.tsx`)).toBe(true);

    // The harness edits the app where the app actually lives.
    await workspace.writeFile(`/orgs/${ORG}/apps/${APP}/src/App.tsx`, "export const App = () => null;\n");
    const result = await workspace.commit();
    expect(result.status).toBe("ok");
    await commitApp(APP, result.status === "ok" ? result.changed : [], workspace, orgCtx, seam);

    // The org edit LANDED — the whole point. Keyed by its path inside the app
    // directory, with no mount prefix left on it.
    const stored = await seam.requireOwned(APP, orgCtx);
    expect(Object.keys(stored.source ?? {})).toEqual(["src/App.tsx"]);
    expect(stored.source!["src/App.tsx"]!.text).toBe("export const App = () => null;\n");
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
  it("refuses a commit against a personal app owned by someone else", async () => {
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
    expect(await workspace.canCommit(`/user/apps/${APP}/app.tsx`)).toBe(true);

    // A caller who stages a file at that path directly still cannot land it.
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
});

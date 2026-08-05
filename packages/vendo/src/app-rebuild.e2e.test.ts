/**
 * The rebuildability proof — contract §2.2/§2.3, Track B's done bar.
 *
 * "The code lives in your database like everything else, and the box is
 * disposable." Before this, an app built in a box existed only inside the E2B
 * snapshot behind `machine.snapshotRef`: lose the snapshot and the customer's app
 * is gone, because the store never had it. `doc.source` demotes that ref to a
 * CACHE — and the only way to know it really is one is to DELETE the snapshot and
 * rebuild the app without it.
 *
 * So this is a seam test with no stub on either side (repo CLAUDE.md's testing
 * law). Every piece is the shipped one:
 *
 *   - the real PGlite store, and the real `workspaceStore(store, { files })` façade
 *   - the real `wrapWorkspaceForRender` commit interception, wired the way
 *     `server.ts` wires it: `commitSource: (input) => apps.commitSource(input, ctx)`
 *   - the real `createApps` runtime behind that verb, so ownership, the
 *     compare-and-swap update and the blob spill are the production ones
 *   - a fake `SandboxAdapter` whose snapshot is genuinely destroyed, so `resume`
 *     genuinely fails and the test cannot pass on a snapshot that is still there
 *
 * The live-box half of the bar (a real E2B box, really re-served) belongs to the
 * builder track; this half proves the STORAGE: what a rebuild has to read.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkoutApp,
  createApps,
  type AppSourceSeam,
  type SandboxAdapter,
  type SandboxMachine,
} from "@vendoai/apps";
import {
  VENDO_APP_FORMAT,
  WORKSPACE_INLINE_MAX_BYTES,
  appDocumentSchema,
  type AppDocument,
  type AppId,
  type FilesAdapter,
  type Principal,
  type RunContext,
  type VendoStore,
  type WorkspaceFs,
} from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { wrapWorkspaceForRender } from "@vendoai/harnesses";
import { appAccess, createStore, workspaceStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_rebuild" };
const READER: Principal = { kind: "user", subject: "user_reader" };
const APP = "app_rebuild_1" as AppId;
const ORG = "maple";
const MEMBERSHIP = { org: ORG, display: "Maple Bank", teams: ["support"], admin: true };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "s_rebuild" };
/** The same person, with the team they belong to asserted — §9.1's host org query,
 *  which is what makes the org mount reachable and the app's address an org one. */
const orgCtx: RunContext = { ...ctx, memberships: [MEMBERSHIP] };

/** The app's files. `src/big.ts` is deliberately past the inline cap, so the
 *  blob-spill leg is proven and not just the inline one — a rebuild that only ever
 *  read `text` would come back with a hole exactly where the bundle is. */
const SOURCE: Record<string, string> = {
  "src/App.tsx": "export const App = () => <div>Spending</div>;\n",
  "vendo.json": '{"name":"Spending","egress":[]}\n',
  "src/server.ts": "export default { fetch: () => new Response('ok') };\n",
  "src/big.ts": `// ${"x".repeat(WORKSPACE_INLINE_MAX_BYTES)}\n`,
};

const TRIGGER = {
  on: { kind: "schedule", cron: "0 9 * * *" },
  run: { kind: "agentic", prompt: "send the digest" },
} as const;

/** An in-memory `FilesAdapter` — the SAME seam the workspace rows spill to, which
 *  is the point: one adapter, two callers, no second spill mechanism. */
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
 * A provider that really HOLDS its snapshots, so destroying one is observable —
 * the only property this test needs from a box, and the one a returns-the-same-
 * machine-forever double cannot give. Local to this file, like every other
 * `SandboxAdapter` double in this package.
 */
function snapshotHoldingSandbox(): SandboxAdapter & { snapshots: Set<string> } {
  const snapshots = new Set<string>();
  let next = 1;
  const boot = (): SandboxMachine => {
    const id = `rebuild_box_${next++}`;
    return {
      id,
      async request() { return { status: 200, headers: {}, body: new Uint8Array() }; },
      async url(port?: number) { return `https://${port ?? 8080}-${id}.rebuild.test`; },
      async snapshot() {
        const ref = `fake:${id}_snap`;
        snapshots.add(ref);
        return ref;
      },
      async stop() { /* sleep */ },
      async destroy() { /* gone; taken refs stay valid */ },
    };
  };
  return {
    snapshots,
    async create() { return boot(); },
    async resume(snapshotRef) {
      // The seam's own word: after `destroy`, "the provider holds no state for it".
      if (!snapshots.has(snapshotRef)) throw new Error(`unknown snapshot: ${snapshotRef}`);
      return boot();
    },
    async destroy(snapshotRef) {
      snapshots.delete(snapshotRef);
    },
  };
}

/** The checkout half's seam, bound over the REAL row exactly as composition does.
 *  Read (`checkoutApp`) is the assertion side of this test; the WRITE side goes
 *  through `apps.commitSource`, which is the production verb under test. */
function readSeam(store: VendoStore, blobs: FilesAdapter): AppSourceSeam {
  const apps = store.records("vendo_apps");
  const row = async (): Promise<{ subject: string; doc: AppDocument }> => {
    const record = await apps.get(APP);
    if (record === null) throw new Error(`no row for ${APP}`);
    const data = record.data as { subject: string; doc: unknown };
    return { subject: data.subject, doc: appDocumentSchema.parse(data.doc) };
  };
  return {
    requireOwned: async () => (await row()).doc,
    ownerOf: async () => (await row()).subject,
    update: async () => {
      throw new Error("the read seam never writes");
    },
    blobs,
  };
}

async function freshStore(): Promise<VendoStore> {
  const root = await mkdtemp(join(tmpdir(), "vendo-app-rebuild-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const store = createStore({ dataDir: join(root, ".data") });
  cleanups.push(async () => store.close());
  await store.ensureSchema();
  return store;
}

/**
 * Carry the app's ROW — and only its row — into another store. This is the whole
 * premise stated as an operation: an app IS its row, so a deployment holding
 * nothing but the row must be able to put the app back. Its grant rows travel too,
 * because on an org app `canCommit` asks them who may write there.
 */
async function carryRowAcross(from: VendoStore, to: VendoStore): Promise<void> {
  const record = await from.records("vendo_apps").get(APP);
  if (record === null) throw new Error(`no row for ${APP}`);
  await to.records("vendo_apps").put(record);
  for (const grant of (await from.records("vendo_app_grants").list({})).records) {
    await to.records("vendo_app_grants").put(grant);
  }
}

async function harness() {
  const store = await freshStore();
  const guard = createGuard({ store, policy: "autopilot" });
  const blobs = memoryBlobs();
  const sandbox = snapshotHoldingSandbox();
  const apps = createApps({
    store,
    guard,
    tools: guard.bind({ async descriptors() { return []; }, async execute() {
      return { status: "error", error: { code: "not-found", message: "no host tools here" } };
    } }),
    catalog: [],
    files: blobs,
    appAccess: appAccess(store),
    // Sharing's WRITES are Cloud-gated; the grant this test asserts survives a
    // rebuild has to be creatable, and `can()` behind it is never key-conditional.
    multiParty: true,
    machine: { sandbox },
  });

  /** The composition line from `packages/vendo/src/server.ts`, verbatim in shape:
   *  the render seam's two app-runtime halves, bound to THIS turn's ctx. */
  const open = async (turnCtx: RunContext = ctx): Promise<WorkspaceFs> => wrapWorkspaceForRender(
    await workspaceStore(store, { files: blobs }).open(
      turnCtx.principal,
      turnCtx.memberships === undefined ? undefined : { memberships: turnCtx.memberships },
    ),
    {
      emit: () => undefined,
      commitSource: (input) => apps.commitSource(input, turnCtx),
    },
  );

  return { store, apps, blobs, sandbox, open };
}

/** A stored app carrying everything §2.4 promises survives an escalation: a
 *  trigger, a placement, and — once the box exists — a machine ref.
 *
 *  `owner` is the row's subject, which IS the app's address (§9.7 — owner and path
 *  prefix always travel together): a person's subject, or an org id verbatim. */
async function seedApp(store: VendoStore, owner: string = principal.subject): Promise<void> {
  const doc = {
    format: VENDO_APP_FORMAT,
    id: APP,
    name: "Spending",
    trigger: TRIGGER,
    placements: ["dashboard.main"],
  } as unknown as AppDocument;
  await store.records("vendo_apps").put({
    id: APP,
    data: { subject: owner, enabled: false, doc },
    refs: { subject: owner },
  });
}

describe.sequential("an app rebuilds from its row onto a fresh box, with its snapshot deleted", () => {
  /**
   * The app is ORG-OWNED, which is the harder address and the only one that can be
   * SHARED: a personal app refuses a grant outright ("move it into a team first"),
   * so a grant is only a thing to survive on a team app. It also puts the whole
   * round trip through `/orgs/<org>/apps/<appId>/**`, where getting the address from
   * permission instead of ownership used to drop every edit silently.
   */
  it("comes back byte for byte — inline files and the blob-spilled one alike", async () => {
    const { store, apps, sandbox, blobs, open } = await harness();
    await seedApp(store, ORG);
    const root = `/orgs/${ORG}/apps/${APP}`;

    // ── 1. BUILD. The builder's writes reach the store through the ONE
    // interception point: this façade's `commit()`. That is the same door the
    // sandbox sync-back path uses (`materialize.ts` writes then commits here), so
    // this is the real write path whether the hands were in-process or in a box.
    const building = await open(orgCtx);
    for (const [path, text] of Object.entries(SOURCE)) {
      await building.writeFile(`${root}/${path}`, text);
    }
    const landed = await building.commit();
    expect(landed.status).toBe("ok");

    // The row is now the truth: every file, hashed, with the big one spilled.
    const stored = await apps.get(APP, orgCtx);
    expect(Object.keys(stored!.source ?? {}).sort()).toEqual(Object.keys(SOURCE).sort());
    expect(stored!.source!["src/big.ts"]!.text).toBeUndefined();
    expect(blobs.keys()).toContain(stored!.source!["src/big.ts"]!.blobRef);
    expect(stored!.source!["src/App.tsx"]!.text).toBe(SOURCE["src/App.tsx"]);

    // A grant, so the rebuild can be asked whether sharing survived it.
    await apps.access.grant(APP, `user:${READER.subject}`, "viewer", orgCtx);

    // ── 2. THE BOX. A machine is minted and its ref stored, which is the state
    // that used to be the app's ONLY home. Written onto the row directly rather
    // than through `provision`: what is under test is whether the ref is a cache,
    // not how it is taken.
    const machine = await sandbox.create({ env: { PORT: "8080" } });
    const snapshotRef = await machine.snapshot();
    await store.records("vendo_apps").put({
      id: APP,
      data: {
        subject: ORG,
        enabled: false,
        doc: { ...(await apps.get(APP, orgCtx))!, machine: { snapshotRef, provisionedAt: new Date().toISOString() } },
      },
      refs: { subject: ORG },
    });
    await expect(sandbox.resume(snapshotRef)).resolves.toBeDefined();

    // ── 3. DELETE THE SNAPSHOT. `destroy` is documented as exactly this:
    // "afterwards resume(snapshotRef) fails and the provider holds no state for
    // it." Asserting the failure is what stops this test passing by accident on a
    // snapshot that is quietly still there.
    await sandbox.destroy(snapshotRef);
    await expect(sandbox.resume(snapshotRef)).rejects.toThrow(/unknown snapshot/);
    expect(sandbox.snapshots.has(snapshotRef)).toBe(false);

    // ── 4. REBUILD. A FRESH box, and a workspace over an EMPTY store that has
    // never held these files — the app's ROW is the only thing carried across, plus
    // the blobs its row points at. Reopening a workspace over the SAME store would
    // prove nothing: those file rows are the working copy the build left behind, so
    // the checkout would be a no-op and the read-backs would pass with `doc.source`
    // completely empty (measured — see the falsification note in the PR). The whole
    // claim is that the ROW is enough, so the row is all it gets.
    const fresh = await sandbox.create({ env: { PORT: "8080" } });
    expect(fresh.id).not.toBe(machine.id);
    const elsewhere = await freshStore();
    await carryRowAcross(store, elsewhere);
    const rebuilt = await workspaceStore(elsewhere, { files: blobs })
      .open(principal, { memberships: [MEMBERSHIP] });
    // Nothing of this app is in that workspace yet — the disk really is blank.
    await expect(rebuilt.readFile(`${root}/src/App.tsx`)).rejects.toThrow();

    await checkoutApp(APP, rebuilt, orgCtx, readSeam(elsewhere, blobs));
    for (const [path, text] of Object.entries(SOURCE)) {
      expect(await rebuilt.readFile(`${root}/${path}`)).toBe(text);
    }

    // ── 5. AND THE APP IS STILL THE SAME APP. §2.4: escalation is no longer a
    // migration, so nothing but `source` may have moved.
    const after = await apps.get(APP, orgCtx);
    expect(after!.id).toBe(APP);
    expect(after!.trigger).toEqual(TRIGGER);
    expect(after!.placements).toEqual(["dashboard.main"]);
    expect((await apps.access.list(APP, orgCtx)).map((grant) => grant.principal))
      .toEqual([`user:${READER.subject}`]);
  }, 120_000);

  /**
   * `trigger` is the one obligation this contract carries toward automations:
   * don't gratuitously break it. A source commit is not a generation, so every
   * field but `source` rides through untouched — asserted over SEVERAL commits,
   * because a mutate that rebuilds the document instead of spreading it would only
   * lose the trigger on the second one.
   */
  it("carries trigger, placements and every other field through commit after commit", async () => {
    const { store, apps, open } = await harness();
    await seedApp(store);

    const workspace = await open();
    for (const round of ["one", "two", "three"]) {
      await workspace.writeFile(`/user/apps/${APP}/src/App.tsx`, `// ${round}\n`);
      expect((await workspace.commit()).status).toBe("ok");
      const doc = await apps.get(APP, ctx);
      expect(doc!.trigger).toEqual(TRIGGER);
      expect(doc!.placements).toEqual(["dashboard.main"]);
      expect(doc!.name).toBe("Spending");
      expect(doc!.source!["src/App.tsx"]!.text).toBe(`// ${round}\n`);
    }
  }, 120_000);

  /**
   * The persistence is a courtesy on top of a landed commit and can never fail
   * one — but a silently dropped source file is a lost app, so a failure is loud.
   * A commit under an app directory with no row is the honest case for that: the
   * files landed in the workspace, and there is no app to persist them onto.
   */
  it("never fails the commit that carried it, even with no app row to write to", async () => {
    const { open } = await harness();
    const workspace = await open();
    await workspace.writeFile(`/user/apps/app_no_such_row/src/App.tsx`, "orphan\n");
    const result = await workspace.commit();
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.changed).toContain("/user/apps/app_no_such_row/src/App.tsx");
    // And the workspace still holds the file: the commit really did land.
    expect(await workspace.readFile(`/user/apps/app_no_such_row/src/App.tsx`)).toBe("orphan\n");
  }, 120_000);
});

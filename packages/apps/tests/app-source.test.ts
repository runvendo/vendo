/**
 * Checkout and commit (contract §3.2) — the app row projected onto a workspace
 * and diffed back.
 *
 * Tested as a ROUND TRIP, not as two halves: `checkoutApp` writes into a
 * workspace and `commitApp` reads back out of that SAME workspace, so the two
 * can genuinely disagree about an address, a path filter, or a hash and the test
 * will say so. The one stand-in is the workspace itself — the shared medium both
 * sides cross — and it is a real staging filesystem (writes land, reads come
 * back, `exists` answers from the index) rather than a recorder of calls.
 *
 * The promise all of this exists to keep: an app can always be rebuilt from its
 * row. Every case below is a way that promise gets quietly broken — content that
 * is not the content stored, a projection landing in the wrong mount, a blob
 * store having a bad minute read as a deletion.
 */
import {
  VENDO_APP_FORMAT,
  VendoError,
  WORKSPACE_INLINE_MAX_BYTES,
  sha256Hex,
  type AppId,
  type FilesAdapter,
  type Membership,
  type RunContext,
  type WorkspaceFs,
} from "@vendoai/core";
import {
  type AppDocument,
  type AppSourceFile,
} from "../src/contract/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appMountFor, checkoutApp, commitApp, invalidSourcePath, type AppSourceSeam } from "../src/server/persistence/app-source.js";

const APP = "app_source" as AppId;
const ADA = "user_ada";

const contentHash = (text: string): string => `sha256:${sha256Hex(text)}`;
const inline = (text: string): AppSourceFile => ({
  hash: contentHash(text),
  bytes: new TextEncoder().encode(text).byteLength,
  text,
});

const ctxFor = (subject: string, memberships: Membership[] = []): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
  ...(memberships.length === 0 ? {} : { memberships }),
}) as RunContext;

const docWith = (source?: Record<string, AppSourceFile>): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: APP,
  name: "Retention",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "Retention" } }],
    data: {},
    queries: [],
  },
  ...(source === undefined ? {} : { source }),
});

/**
 * A staging workspace: writes are held, reads come back, `exists` answers from
 * the index the way the real façade does (from the row, never the blob). Writes
 * outside `writable` are refused by `canCommit`, which is the mount gate.
 */
const workspaceFs = (options: { writable?: (path: string) => boolean } = {}) => {
  const files = new Map<string, string>();
  /** Paths that exist but whose bytes will not come back — a blob store having
   *  a bad minute, which must NOT read as a deletion. */
  const unreadable = new Set<string>();
  const fs = {
    async writeFile(path: string, content: string) { files.set(path, content); },
    async readFile(path: string) {
      if (unreadable.has(path)) throw new Error(`ENOENT: ${path}`);
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    async exists(path: string) { return files.has(path); },
    async canCommit(path: string) { return options.writable?.(path) ?? true; },
    getAllPaths() { return [...files.keys()]; },
  };
  return Object.assign(fs as unknown as WorkspaceFs, {
    files,
    breakRead(path: string) { unreadable.add(path); },
  });
};

/** The store side of the seam, as composition binds it. `doc()` reads the LIVE
 *  row — a getter copied through `Object.assign` would freeze it at its initial
 *  value and every commit assertion would silently read the pre-commit row. */
const seamFor = (doc: AppDocument, options: { owner?: string; blobs?: FilesAdapter } = {}) => {
  let current = doc;
  const seam: AppSourceSeam = {
    async requireOwned() { return current; },
    async update(_appId, mutate) { current = mutate(current); return current; },
    async ownerOf() { return options.owner ?? ADA; },
    ...(options.blobs === undefined ? {} : { blobs: options.blobs }),
  };
  return Object.assign(seam, { doc: () => current });
};

const memoryBlobs = () => {
  const bytes = new Map<string, Uint8Array>();
  const adapter: FilesAdapter = {
    async put(key, value) { bytes.set(key, value); },
    async get(key) { const found = bytes.get(key); return found === undefined ? undefined : { bytes: found }; },
    async delete(key) { bytes.delete(key); },
  };
  return Object.assign(adapter, { bytes });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("invalidSourcePath — a source key is a POSIX-relative path inside the app directory", () => {
  it("accepts an ordinary nested path", () => {
    expect(invalidSourcePath("src/components/Chart.tsx")).toBeNull();
  });

  it("refuses an empty path", () => {
    expect(invalidSourcePath("")).toMatch(/must not be empty/);
  });

  it("refuses an absolute path", () => {
    expect(invalidSourcePath("/etc/passwd")).toMatch(/must be relative to the app directory/);
  });

  for (const traversal of ["../other-app/app.vendo", "src/../../escape.ts", "..", "./here.ts", "src//double.ts"]) {
    it(`refuses ${JSON.stringify(traversal)} — the one way a checkout could reach another app's files`, () => {
      expect(invalidSourcePath(traversal)).toMatch(/must not contain empty or dot segments/);
    });
  }

  for (const hot of ["app.vendo", "plan.vendo"]) {
    it(`refuses ${hot}, which is the render seam's and not the source tree's`, () => {
      expect(invalidSourcePath(hot)).toMatch(/render seam's/);
    });
  }
});

describe("appMountFor — the address is a fact about the app, never about who is asking", () => {
  it("resolves an owner the caller holds a membership for as the ORG mount", () => {
    const ctx = ctxFor(ADA, [{ org: "org_acme" } as Membership]);
    expect(appMountFor("org_acme", ctx)).toEqual({ kind: "org", org: "org_acme" });
  });

  it("resolves anything else as that owner's personal mount", () => {
    expect(appMountFor(ADA, ctxFor(ADA))).toEqual({ kind: "user", subject: ADA });
  });

  it("resolves a personal app shared with the caller to its OWNER's mount, not the caller's", () => {
    // An honest refusal downstream beats a write in the wrong place.
    expect(appMountFor("user_bob", ctxFor(ADA))).toEqual({ kind: "user", subject: "user_bob" });
  });
});

describe("checkoutApp — the row projected onto the workspace", () => {
  it("writes app.vendo from the tree and every source file at its path", async () => {
    const workspace = workspaceFs();
    const doc = docWith({ "src/chart.tsx": inline("export default () => null;\n") });

    await checkoutApp(APP, workspace, ctxFor(ADA), seamFor(doc));

    expect(workspace.files.get(`/user/apps/${APP}/app.vendo`)).toContain("Retention");
    expect(workspace.files.get(`/user/apps/${APP}/src/chart.tsx`)).toBe("export default () => null;\n");
  });

  it("projects an ORG-owned app under the org mount, not the caller's own", async () => {
    // The defect this pins: taking the first WRITABLE candidate put an org app
    // in /user, commitApp derived that same prefix, and every /orgs edit was
    // silently filtered out and dropped.
    const workspace = workspaceFs();
    const ctx = ctxFor(ADA, [{ org: "org_acme" } as Membership]);

    await checkoutApp(APP, workspace, ctx, seamFor(docWith({ "a.ts": inline("a\n") }), { owner: "org_acme" }));

    expect(workspace.files.has(`/orgs/org_acme/apps/${APP}/a.ts`)).toBe(true);
    expect(workspace.files.has(`/user/apps/${APP}/a.ts`)).toBe(false);
  });

  it("refuses an app that lives in another person's workspace", async () => {
    const workspace = workspaceFs();

    await expect(checkoutApp(APP, workspace, ctxFor(ADA), seamFor(docWith(), { owner: "user_bob" })))
      .rejects.toThrow(/lives in another person's workspace/);
  });

  it("refuses when the workspace cannot hold the app's files", async () => {
    const workspace = workspaceFs({ writable: () => false });

    await expect(checkoutApp(APP, workspace, ctxFor(ADA), seamFor(docWith())))
      .rejects.toThrow(/cannot hold .* files at/);
  });

  it("writes no app.vendo for a document whose tree is absent or unusable", async () => {
    const workspace = workspaceFs();
    const doc = { id: APP, name: "Treeless" } as AppDocument;

    await checkoutApp(APP, workspace, ctxFor(ADA), seamFor(doc));

    expect(workspace.files.has(`/user/apps/${APP}/app.vendo`)).toBe(false);
  });

  it("refuses a stored source key that would escape the app directory", async () => {
    const workspace = workspaceFs();
    const doc = docWith({ "../escape.ts": inline("x\n") });

    await expect(checkoutApp(APP, workspace, ctxFor(ADA), seamFor(doc)))
      .rejects.toThrow(/must not contain empty or dot segments/);
  });
});

describe("checkoutApp fails CLOSED on content that is not the content stored", () => {
  it("refuses a file whose byte count disagrees with its row", async () => {
    const workspace = workspaceFs();
    const doc = docWith({ "a.ts": { ...inline("hello\n"), bytes: 999 } });

    await expect(checkoutApp(APP, workspace, ctxFor(ADA), seamFor(doc)))
      .rejects.toThrow(/is 6 bytes but its row says 999/);
  });

  it("refuses a file whose hash disagrees with its row", async () => {
    const workspace = workspaceFs();
    const doc = docWith({ "a.ts": { ...inline("hello\n"), hash: `sha256:${"0".repeat(64)}` } });

    await expect(checkoutApp(APP, workspace, ctxFor(ADA), seamFor(doc)))
      .rejects.toThrow(/hashes to sha256:.* but its row says/);
  });

  it("refuses a file carrying neither text nor a blob reference", async () => {
    const workspace = workspaceFs();
    const doc = docWith({ "a.ts": { hash: contentHash("a\n"), bytes: 2 } });

    await expect(checkoutApp(APP, workspace, ctxFor(ADA), seamFor(doc)))
      .rejects.toThrow(/carries neither text nor a blob reference/);
  });

  it("reads a spilled file back through the blob seam", async () => {
    const workspace = workspaceFs();
    const blobs = memoryBlobs();
    const text = "spilled\n";
    await blobs.put("apps/blob-key", new TextEncoder().encode(text));
    const doc = docWith({ "big.ts": { hash: contentHash(text), bytes: 8, blobRef: "apps/blob-key" } });

    await checkoutApp(APP, workspace, ctxFor(ADA), seamFor(doc, { blobs }));

    expect(workspace.files.get(`/user/apps/${APP}/big.ts`)).toBe(text);
  });

  it("refuses loudly when the row points at bytes that are gone", async () => {
    const workspace = workspaceFs();
    const doc = docWith({ "big.ts": { hash: contentHash("x"), bytes: 1, blobRef: "apps/missing" } });

    await expect(checkoutApp(APP, workspace, ctxFor(ADA), seamFor(doc, { blobs: memoryBlobs() })))
      .rejects.toThrow(/is missing its stored bytes/);
  });
});

describe("commitApp — the changed paths diffed back into the row", () => {
  /** Check the app out, edit it in the workspace, commit the paths that moved —
   *  the real sequence, through the same workspace both ends. */
  const roundTrip = async (
    doc: AppDocument,
    edit: (workspace: ReturnType<typeof workspaceFs>, dir: string) => void | Promise<void>,
    options: { changed?: string[]; blobs?: FilesAdapter; owner?: string } = {},
  ) => {
    const workspace = workspaceFs();
    const seam = seamFor(doc, options);
    const ctx = ctxFor(ADA);
    await checkoutApp(APP, workspace, ctx, seam);
    const dir = `/user/apps/${APP}`;
    await edit(workspace, dir);
    await commitApp(APP, options.changed ?? [...workspace.files.keys()], workspace, ctx, seam);
    return seam.doc();
  };

  it("lands an edited file's new bytes, hash and size in doc.source", async () => {
    const after = await roundTrip(docWith({ "a.ts": inline("old\n") }), (workspace, dir) => {
      workspace.files.set(`${dir}/a.ts`, "new\n");
    });

    expect(after.source?.["a.ts"]).toEqual({ hash: contentHash("new\n"), bytes: 4, text: "new\n" });
  });

  it("lands a file the workspace grew that the row never had", async () => {
    const after = await roundTrip(docWith({ "a.ts": inline("a\n") }), (workspace, dir) => {
      workspace.files.set(`${dir}/added.ts`, "added\n");
    });

    expect(after.source?.["added.ts"]?.text).toBe("added\n");
  });

  it("drops a path that is gone from the workspace", async () => {
    const after = await roundTrip(docWith({ "a.ts": inline("a\n"), "b.ts": inline("b\n") }), (workspace, dir) => {
      workspace.files.delete(`${dir}/b.ts`);
    }, { changed: [`/user/apps/${APP}/b.ts`] });

    expect(after.source?.["b.ts"]).toBeUndefined();
    expect(after.source?.["a.ts"]).toBeDefined();
  });

  it("KEEPS a stored entry whose file is still there but would not read — stale beats gone", async () => {
    // A spilled file's read-back is a live fetch, so a blob store having a bad
    // minute used to look exactly like a deletion. `exists()` is the
    // discriminator; the thrown error deliberately is not.
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const after = await roundTrip(docWith({ "a.ts": inline("a\n") }), (workspace, dir) => {
      workspace.breakRead(`${dir}/a.ts`);
    });

    expect(after.source?.["a.ts"]?.text).toBe("a\n");
    expect(errors.mock.calls.flat().join(" ")).toMatch(/still there but would not read back/);
  });

  it("still lands the other files in a commit where one path would not read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const after = await roundTrip(docWith({ "a.ts": inline("a\n"), "b.ts": inline("b\n") }), (workspace, dir) => {
      workspace.breakRead(`${dir}/a.ts`);
      workspace.files.set(`${dir}/b.ts`, "b-new\n");
    });

    expect(after.source?.["a.ts"]?.text).toBe("a\n");
    expect(after.source?.["b.ts"]?.text).toBe("b-new\n");
  });

  it("ignores paths outside this app's directory", async () => {
    const after = await roundTrip(docWith({ "a.ts": inline("a\n") }), (workspace) => {
      workspace.files.set("/user/memory/notes.md", "not the app's\n");
    });

    expect(Object.keys(after.source ?? {})).toEqual(["a.ts"]);
  });

  it("ignores the two hot files the render seam owns", async () => {
    const after = await roundTrip(docWith({ "a.ts": inline("a\n") }), (workspace, dir) => {
      workspace.files.set(`${dir}/plan.vendo`, "plan\n");
    });

    // app.vendo is written by the checkout itself and must not come back as source.
    expect(Object.keys(after.source ?? {})).toEqual(["a.ts"]);
  });

  it("lands nothing at all when no changed path belongs to this app", async () => {
    const doc = docWith({ "a.ts": inline("a\n") });
    const workspace = workspaceFs();
    const seam = seamFor(doc);
    const ctx = ctxFor(ADA);
    await checkoutApp(APP, workspace, ctx, seam);
    const update = vi.spyOn(seam, "update");

    await commitApp(APP, ["/user/memory/notes.md"], workspace, ctx, seam);

    expect(update).not.toHaveBeenCalled();
  });

  it("does not rewrite a path whose content still matches its stored hash", async () => {
    // The stored hash IS the checkout base, so an unchanged file is not a write.
    const original = inline("a\n");
    const after = await roundTrip(docWith({ "a.ts": original }), () => undefined);

    expect(after.source?.["a.ts"]).toBe(original);
  });

  it("drops the source field entirely when the last file goes", async () => {
    const after = await roundTrip(docWith({ "a.ts": inline("a\n") }), (workspace, dir) => {
      workspace.files.delete(`${dir}/a.ts`);
    }, { changed: [`/user/apps/${APP}/a.ts`] });

    expect("source" in after).toBe(false);
  });

  it("leaves every other field of the document untouched — `trigger` above all", async () => {
    const doc = { ...docWith({ "a.ts": inline("a\n") }), triggers: [{ id: "t1", kind: "schedule" }] } as unknown as AppDocument;

    const after = await roundTrip(doc, (workspace, dir) => {
      workspace.files.set(`${dir}/a.ts`, "changed\n");
    });

    expect((after as { triggers?: unknown }).triggers).toEqual([{ id: "t1", kind: "schedule" }]);
    expect(after.name).toBe("Retention");
  });
});

describe("commitApp spills past the inline cap", () => {
  const oversized = "x".repeat(WORKSPACE_INLINE_MAX_BYTES + 1);

  it("puts an oversized file in the blob namespace and stores a blobRef, not text", async () => {
    const workspace = workspaceFs();
    const blobs = memoryBlobs();
    const seam = seamFor(docWith({ "a.ts": inline("a\n") }), { blobs });
    const ctx = ctxFor(ADA);
    await checkoutApp(APP, workspace, ctx, seam);
    workspace.files.set(`/user/apps/${APP}/big.ts`, oversized);

    await commitApp(APP, [`/user/apps/${APP}/big.ts`], workspace, ctx, seam);

    const landed = seam.doc().source?.["big.ts"];
    expect(landed?.text).toBeUndefined();
    expect(landed?.blobRef).toMatch(new RegExp(`^apps/${APP}/[0-9a-f]{64}$`));
    // Keyed by app, so erasing the app erases its source.
    expect(blobs.bytes.has(landed?.blobRef ?? "")).toBe(true);
  });

  it("refuses loudly when there is no files adapter to spill to", async () => {
    const workspace = workspaceFs();
    const seam = seamFor(docWith({ "a.ts": inline("a\n") }));
    const ctx = ctxFor(ADA);
    await checkoutApp(APP, workspace, ctx, seam);
    workspace.files.set(`/user/apps/${APP}/big.ts`, oversized);

    await expect(commitApp(APP, [`/user/apps/${APP}/big.ts`], workspace, ctx, seam))
      .rejects.toThrow(/past the .*-byte inline cap/);
  });

  it("names both ways out — a files adapter, or a smaller file", async () => {
    const workspace = workspaceFs();
    const seam = seamFor(docWith(), {});
    const ctx = ctxFor(ADA);
    await checkoutApp(APP, workspace, ctx, seam);
    workspace.files.set(`/user/apps/${APP}/big.ts`, oversized);

    await expect(commitApp(APP, [`/user/apps/${APP}/big.ts`], workspace, ctx, seam))
      .rejects.toThrow(/configure one, or keep the file smaller/);
  });
});

describe("a spilled file survives the whole round trip", () => {
  it("commits past the cap and checks back out with the same bytes", async () => {
    // The promise: an app can always be rebuilt from its row. A spill is where
    // that is easiest to break, because the bytes leave the row entirely.
    const blobs = memoryBlobs();
    const seam = seamFor(docWith(), { blobs });
    const ctx = ctxFor(ADA);
    const text = `${"y".repeat(WORKSPACE_INLINE_MAX_BYTES + 1)}\n`;

    const writing = workspaceFs();
    await checkoutApp(APP, writing, ctx, seam);
    writing.files.set(`/user/apps/${APP}/big.ts`, text);
    await commitApp(APP, [`/user/apps/${APP}/big.ts`], writing, ctx, seam);

    // A FRESH workspace, so nothing survives except through the row + blobs.
    const reading = workspaceFs();
    await checkoutApp(APP, reading, ctx, seam);

    expect(reading.files.get(`/user/apps/${APP}/big.ts`)).toBe(text);
  });
});

describe("commitApp refuses the same addresses checkoutApp does", () => {
  it("refuses an app that lives in another person's workspace", async () => {
    await expect(commitApp(APP, [], workspaceFs(), ctxFor(ADA), seamFor(docWith(), { owner: "user_bob" })))
      .rejects.toThrow(VendoError);
  });

  it("refuses when the workspace cannot hold the app's files", async () => {
    await expect(commitApp(APP, [], workspaceFs({ writable: () => false }), ctxFor(ADA), seamFor(docWith())))
      .rejects.toThrow(/cannot hold/);
  });
});

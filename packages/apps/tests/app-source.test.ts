/**
 * Commit (contract §3.2) — the app's workspace directory diffed back into its
 * row, plus the two rules that decide WHICH paths a commit may touch
 * (`invalidSourcePath`) and WHERE the app's directory is (`appMountFor`).
 *
 * The one stand-in is the workspace itself — the medium the edits cross — and it
 * is a real staging filesystem (writes land, reads come back, `exists` answers
 * from the index) rather than a recorder of calls.
 *
 * The promise all of this exists to keep: an app can always be rebuilt from its
 * row. Every case below is a way that promise gets quietly broken — an edit
 * diffed back from the wrong mount, a hash that is not the content's, a blob
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
import { appMountFor, commitApp, invalidSourcePath, type AppSourceSeam } from "../src/server/persistence/app-source.js";

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

  for (const traversal of ["../other-app/app.tsx", "src/../../escape.ts", "..", "./here.ts", "src//double.ts"]) {
    it(`refuses ${JSON.stringify(traversal)} — the one way a commit could reach another app's files`, () => {
      expect(invalidSourcePath(traversal)).toMatch(/must not contain empty or dot segments/);
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

describe("commitApp — the changed paths diffed back into the row", () => {
  /** The app's directory as its row describes it, edited in the workspace, then
   *  the paths that moved committed back — the real sequence. */
  const roundTrip = async (
    doc: AppDocument,
    edit: (workspace: ReturnType<typeof workspaceFs>, dir: string) => void | Promise<void>,
    options: { changed?: string[]; blobs?: FilesAdapter; owner?: string } = {},
  ) => {
    const workspace = workspaceFs();
    const seam = seamFor(doc, options);
    const ctx = ctxFor(ADA);
    const dir = `/user/apps/${APP}`;
    for (const [path, file] of Object.entries(doc.source ?? {})) {
      workspace.files.set(`${dir}/${path}`, file.text ?? "");
    }
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

  it("ignores app.tsx, the hot file the render seam owns", async () => {
    const after = await roundTrip(docWith({ "a.ts": inline("a\n") }), (workspace, dir) => {
      workspace.files.set(`${dir}/app.tsx`, "export default function A() { return null; }\n");
    });

    // The PAINT stores the screen, and only after the component gauntlet passed
    // it — a screen the floor refused must not reach `source` through this diff.
    expect(Object.keys(after.source ?? {})).toEqual(["a.ts"]);
  });

  it("lands nothing at all when no changed path belongs to this app", async () => {
    const seam = seamFor(docWith({ "a.ts": inline("a\n") }));
    const workspace = workspaceFs();
    const ctx = ctxFor(ADA);
    const update = vi.spyOn(seam, "update");

    await commitApp(APP, ["/user/memory/notes.md"], workspace, ctx, seam);

    expect(update).not.toHaveBeenCalled();
  });

  it("does not rewrite a path whose content still matches its stored hash", async () => {
    // The stored hash IS the base a commit diffs against, so an unchanged file
    // is not a write.
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

  it("leaves every other field of the document untouched — `automations` above all", async () => {
    const doc = { ...docWith({ "a.ts": inline("a\n") }), automations: ["atm_one"] } as unknown as AppDocument;

    const after = await roundTrip(doc, (workspace, dir) => {
      workspace.files.set(`${dir}/a.ts`, "changed\n");
    });

    expect((after as { automations?: unknown }).automations).toEqual(["atm_one"]);
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
    workspace.files.set(`/user/apps/${APP}/big.ts`, oversized);

    await expect(commitApp(APP, [`/user/apps/${APP}/big.ts`], workspace, ctx, seam))
      .rejects.toThrow(/past the .*-byte inline cap/);
  });

  it("names both ways out — a files adapter, or a smaller file", async () => {
    const workspace = workspaceFs();
    const seam = seamFor(docWith(), {});
    const ctx = ctxFor(ADA);
    workspace.files.set(`/user/apps/${APP}/big.ts`, oversized);

    await expect(commitApp(APP, [`/user/apps/${APP}/big.ts`], workspace, ctx, seam))
      .rejects.toThrow(/configure one, or keep the file smaller/);
  });
});

describe("commitApp refuses an address it must not write", () => {
  it("refuses an app that lives in another person's workspace", async () => {
    await expect(commitApp(APP, [], workspaceFs(), ctxFor(ADA), seamFor(docWith(), { owner: "user_bob" })))
      .rejects.toThrow(VendoError);
  });

  it("refuses when the workspace cannot hold the app's files", async () => {
    await expect(commitApp(APP, [], workspaceFs({ writable: () => false }), ctxFor(ADA), seamFor(docWith())))
      .rejects.toThrow(/cannot hold/);
  });
});

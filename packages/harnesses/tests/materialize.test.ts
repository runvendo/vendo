import { describe, expect, test } from "vitest";
import { checkoutWorkspace, contentHash, inWritableMount } from "../src/materialize.js";
import { testAppsHooks, testWorkspace } from "../src/test-doubles.test-util.js";

/** The injected hot-path predicate, exactly as the driver passes it
 *  (claude-code/index.ts): a path the vocabulary maps to an appId is hot. */
const isHot = (path: string): boolean => testAppsHooks().hotPaths.appId(path) !== undefined;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, text: string) => ({ path, bytes: bytes(text) });

/**
 * `pathAccess` — the wave-1 stand-in this block used to pin — is GONE, and with
 * it the assertion that `/orgs/acme/apps/app_1/app.tsx` is `none`. That was
 * true when written and became the bug: wave 3 shipped org mounts, and a
 * hardcoded path table answered for them anyway, so every team file was
 * invisible to `claudeCode()`. Permission is now the workspace's own
 * `canCommit()` (§9.3, live rows, per file), asked at both checkout and
 * sync-back — see the per-file blocks below. What is left of the path table is
 * a mount SHAPE, for the one caller that has no store to ask: a disk walk.
 */
describe("inWritableMount — the mounts a machine's walk carries home", () => {
  test("the two writable mounts come home; /host and non-mounts never do", () => {
    expect(inWritableMount("/user/memory/notes.md")).toBe(true);
    expect(inWritableMount("/orgs/acme/apps/app_1/app.tsx")).toBe(true);
    expect(inWritableMount("/host/skills/refund/SKILL.md")).toBe(false);
    expect(inWritableMount("/etc/passwd")).toBe(false);
  });

  test("the walk's answer is about the RESOLVED path", () => {
    // A real disk hands back path strings, so `/user/../etc/passwd` is a shape
    // that can arrive; judging it unresolved would call it a `/user` path.
    expect(inWritableMount("/user/../etc/passwd")).toBe(false);
    expect(inWritableMount("/orgs/acme/../../etc/passwd")).toBe(false);
  });

  test("a bare mount ROOT is not a file a walk carries home", () => {
    // The retired `pathAccess` answered "rw" for a bare `/user` and "ro" for a
    // bare `/host`, because it graded MOUNTS. This grades what a disk walk
    // found, and a walk only ever yields files — a mount root is a directory.
    // Checkout reaches the same answer from the other side: the root matches the
    // mount shape, and `readFileBuffer` on a directory throws, so it is skipped.
    expect(inWritableMount("/user")).toBe(false);
    expect(inWritableMount("/host")).toBe(false);
    expect(inWritableMount("/orgs/acme")).toBe(false);
  });
});

describe("checkout — the box is born filtered (design §8)", () => {
  test("carries every visible file, read-only iff the caller cannot commit it", async () => {
    const workspace = testWorkspace({
      "/user/apps/app_1/app.tsx": "<App/>",
      "/host/skills/refund/SKILL.md": "# refund",
    });
    const checkout = await checkoutWorkspace(workspace);
    expect([...checkout.files].map((entry) => [entry.path, entry.readOnly]).sort()).toEqual([
      ["/host/skills/refund/SKILL.md", true],
      ["/user/apps/app_1/app.tsx", false],
    ]);
  });

  test("a team file the caller may edit is materialized, writable", async () => {
    const workspace = testWorkspace({ "/orgs/acme/apps/app_1/app.tsx": "team app" });
    const checkout = await checkoutWorkspace(workspace);
    expect(checkout.files.map((entry) => [entry.path, entry.readOnly])).toEqual([
      ["/orgs/acme/apps/app_1/app.tsx", false],
    ]);
  });

  test("readOnly is PER FILE, not per mount — viewer level lands beside editor", async () => {
    const workspace = testWorkspace({
      "/orgs/acme/apps/app_mine/app.tsx": "editable",
      "/orgs/acme/apps/app_theirs/app.tsx": "viewer only",
    });
    workspace.readOnlyPaths = ["/orgs/acme/apps/app_theirs/app.tsx"];
    const checkout = await checkoutWorkspace(workspace);
    expect([...checkout.files].map((entry) => [entry.path, entry.readOnly]).sort()).toEqual([
      ["/orgs/acme/apps/app_mine/app.tsx", false],
      ["/orgs/acme/apps/app_theirs/app.tsx", true],
    ]);
  });

  test("a path outside the mounts is never materialized", async () => {
    const workspace = testWorkspace({ "/tmp/secret": "nope", "/user/memory/a.md": "yes" });
    const checkout = await checkoutWorkspace(workspace);
    expect(checkout.files.map((entry) => entry.path)).toEqual(["/user/memory/a.md"]);
  });
});

describe("syncAll — diff-based per file, never wholesale (§3.5)", () => {
  test("only the files whose content hash changed are committed", async () => {
    const workspace = testWorkspace({
      "/user/memory/a.md": "one",
      "/user/memory/b.md": "two",
    });
    const checkout = await checkoutWorkspace(workspace);
    const changed = await checkout.syncAll([
      file("/user/memory/a.md", "one"),
      file("/user/memory/b.md", "TWO"),
    ]);
    expect(changed).toEqual(["/user/memory/b.md"]);
    expect(workspace.commits.at(-1)?.changed).toEqual(["/user/memory/b.md"]);
  });

  test("a file the box created lands", async () => {
    const workspace = testWorkspace({});
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncAll([file("/user/files/report.md", "hi")])).toEqual([
      "/user/files/report.md",
    ]);
    expect(await workspace.readFile("/user/files/report.md")).toBe("hi");
  });

  test("/user/scratch/** never syncs", async () => {
    const workspace = testWorkspace({});
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncAll([file("/user/scratch/junk.txt", "junk")])).toEqual([]);
    expect(await workspace.exists("/user/scratch/junk.txt")).toBe(false);
  });

  test("a write to the read-only /host mount is refused, not committed", async () => {
    const workspace = testWorkspace({ "/host/skills/refund/SKILL.md": "# refund" });
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncAll([file("/host/skills/refund/SKILL.md", "# rewritten")])).toEqual([]);
    expect(await workspace.readFile("/host/skills/refund/SKILL.md")).toBe("# refund");
  });

  test("a path outside the mounts is refused", async () => {
    const workspace = testWorkspace({});
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncAll([file("/etc/passwd", "root")])).toEqual([]);
    expect(await workspace.exists("/etc/passwd")).toBe(false);
  });

  test("a team file the caller may edit lands", async () => {
    const workspace = testWorkspace({ "/orgs/acme/files/plan.md": "base" });
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncAll([file("/orgs/acme/files/plan.md", "revised")])).toEqual([
      "/orgs/acme/files/plan.md",
    ]);
    expect(await workspace.readFile("/orgs/acme/files/plan.md")).toBe("revised");
  });

  test("a viewer-level team file the box wrote anyway never lands", async () => {
    // The box materialized it read-only, and a process running as the file's
    // owner can chmod that back — so sync-back re-asks, against live rows.
    const workspace = testWorkspace({ "/orgs/acme/apps/app_1/app.tsx": "theirs" });
    workspace.readOnlyPaths = ["/orgs/acme/apps/app_1/app.tsx"];
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncAll([file("/orgs/acme/apps/app_1/app.tsx", "vandalised")])).toEqual([]);
    expect(await workspace.readFile("/orgs/acme/apps/app_1/app.tsx")).toBe("theirs");
  });

  test("one refused org path never takes the caller's own work down with it", async () => {
    const workspace = testWorkspace({
      "/orgs/acme/apps/app_1/app.tsx": "theirs",
      "/user/memory/mine.md": "before",
    });
    workspace.readOnlyPaths = ["/orgs/acme/apps/app_1/app.tsx"];
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncAll([
      file("/orgs/acme/apps/app_1/app.tsx", "vandalised"),
      file("/user/memory/mine.md", "after"),
    ])).toEqual(["/user/memory/mine.md"]);
    expect(await workspace.readFile("/user/memory/mine.md")).toBe("after");
  });

  test("a grant revoked mid-session bites at sync-back, not at checkout", async () => {
    const workspace = testWorkspace({ "/orgs/acme/files/plan.md": "base" });
    const checkout = await checkoutWorkspace(workspace);
    // Checked out writable; the revoke lands while the turn is still thinking.
    expect(checkout.files.map((entry) => entry.readOnly)).toEqual([false]);
    workspace.readOnlyPaths = ["/orgs/acme/files/plan.md"];
    expect(await checkout.syncAll([file("/orgs/acme/files/plan.md", "revised")])).toEqual([]);
    expect(await workspace.readFile("/orgs/acme/files/plan.md")).toBe("base");
  });

  test("a DELETION of a file whose grant was revoked mid-session is refused, not thrown", async () => {
    // The façade refuses a forbidden removal by throwing, which would abandon
    // the whole sync — including the caller's own work in the same turn.
    const workspace = testWorkspace({
      "/orgs/acme/files/theirs.md": "theirs",
      "/user/memory/mine.md": "before",
    });
    const checkout = await checkoutWorkspace(workspace);
    workspace.readOnlyPaths = ["/orgs/acme/files/theirs.md"];
    expect(await checkout.syncAll([file("/user/memory/mine.md", "after")])).toEqual([
      "/user/memory/mine.md",
    ]);
    expect(await workspace.exists("/orgs/acme/files/theirs.md")).toBe(true);
  });

  test("/orgs/<org>/scratch never syncs, exactly like /user/scratch", async () => {
    const workspace = testWorkspace({});
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncAll([file("/orgs/acme/scratch/junk.txt", "junk")])).toEqual([]);
    expect(await workspace.exists("/orgs/acme/scratch/junk.txt")).toBe(false);
  });

  test("a file the box deleted is removed from the store", async () => {
    const workspace = testWorkspace({ "/user/memory/gone.md": "bye", "/user/memory/stay.md": "hi" });
    const checkout = await checkoutWorkspace(workspace);
    expect(await checkout.syncAll([file("/user/memory/stay.md", "hi")])).toEqual([
      "/user/memory/gone.md",
    ]);
    expect(await workspace.exists("/user/memory/gone.md")).toBe(false);
  });
});

describe("syncHot — the screen renders mid-turn (§3.5)", () => {
  test("commits ONLY the hot paths, leaving the rest for turn end", async () => {
    const workspace = testWorkspace({});
    const checkout = await checkoutWorkspace(workspace, undefined, true, isHot);
    const files = [
      file("/user/apps/app_1/app.tsx", "screen"),
      file("/user/memory/notes.md", "later"),
    ];
    expect(await checkout.syncHot(files)).toEqual(["/user/apps/app_1/app.tsx"]);
    expect(await workspace.exists("/user/memory/notes.md")).toBe(false);
  });

  test("a hot path already synced and unchanged is not committed twice", async () => {
    const workspace = testWorkspace({});
    const checkout = await checkoutWorkspace(workspace, undefined, true, isHot);
    const files = [file("/user/apps/app_1/app.tsx", "<App/>")];
    expect(await checkout.syncHot(files)).toEqual(["/user/apps/app_1/app.tsx"]);
    expect(await checkout.syncHot(files)).toEqual([]);
    expect(await checkout.syncAll(files)).toEqual([]);
  });

  test("a hot path that changed again after a mid-turn sync lands again", async () => {
    const workspace = testWorkspace({});
    const checkout = await checkoutWorkspace(workspace, undefined, true, isHot);
    await checkout.syncHot([file("/user/apps/app_1/app.tsx", "<App/>")]);
    expect(await checkout.syncHot([file("/user/apps/app_1/app.tsx", "<App>2</App>")])).toEqual([
      "/user/apps/app_1/app.tsx",
    ]);
  });

  test("a TEAM app's hot path syncs mid-turn too — the screen paints either way", async () => {
    const workspace = testWorkspace({});
    const checkout = await checkoutWorkspace(workspace, undefined, true, isHot);
    expect(await checkout.syncHot([file("/orgs/acme/apps/app_1/app.tsx", "screen")])).toEqual([
      "/orgs/acme/apps/app_1/app.tsx",
    ]);
  });

  test("syncHot never deletes — a partial view of the disk is not a deletion", async () => {
    const workspace = testWorkspace({ "/user/memory/keep.md": "keep" });
    const checkout = await checkoutWorkspace(workspace, undefined, true, isHot);
    expect(await checkout.syncHot([])).toEqual([]);
    expect(await workspace.exists("/user/memory/keep.md")).toBe(true);
  });
});

describe("an OVERSIZED checked-out file survives absent-means-deleted", () => {
  test("a file the box walk would skip is never deleted for being absent", async () => {
    // The box door's whole-tree walk skips anything over 8 MiB to protect the
    // proxy body limit. Under the default files store (5 MiB cap) that skip is
    // unreachable for a checked-out file, but a BYO files adapter (s3) has no
    // cap — and reading the skip as an erasure silently destroyed the one copy
    // the store held. Preserving beats propagating a rare real in-box rm.
    const big = "x".repeat(8 * 1024 * 1024 + 1);
    const workspace = testWorkspace({
      "/user/uploads/big.bin": big,
      "/user/memory/small.md": "small",
    });
    const checkout = await checkoutWorkspace(workspace);
    // The box read back neither file: big was walk-skipped, small was deleted.
    const changed = await checkout.syncAll([]);
    expect(changed).toEqual(["/user/memory/small.md"]);
    expect(await workspace.exists("/user/uploads/big.bin")).toBe(true);
    expect(await workspace.exists("/user/memory/small.md")).toBe(false);
  });
});

describe("contentHash", () => {
  test("is stable and content-addressed", () => {
    expect(contentHash(bytes("a"))).toBe(contentHash(bytes("a")));
    expect(contentHash(bytes("a"))).not.toBe(contentHash(bytes("b")));
  });
});

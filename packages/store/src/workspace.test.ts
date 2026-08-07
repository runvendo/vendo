import { VendoError, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { FILES_STORE_MAX_BYTES } from "./files-store.js";
import { dbFor } from "./store.js";
import { workspaceStore, WORKSPACE_HISTORY_LIMIT, WORKSPACE_INLINE_MAX_BYTES } from "./workspace.js";

const user: Principal = { kind: "user", subject: "user_ws" };
/** §9.7 — undo/history take the CALLER (principal + asserted orgs), because
    the owner they address is derived from the path and checked with `can()`. */
const caller = { principal: user };
const APP = "/user/apps/app_1/app.vendo";

for (const backend of backends()) {
  describe(`${backend.name} build contract §3 — the workspace façade`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    const rowsFor = async (path: string): Promise<Record<string, unknown>[]> =>
      await made.sql(
        "SELECT content, blob_ref, bytes, revision FROM vendo_workspace_files WHERE path = $1",
        [path],
      );

    it("commits a written file into the store and reads it back next turn", async () => {
      const workspace = workspaceStore(made.store);
      const first = await workspace.open(user);
      await first.writeFile(APP, "page: hello");
      const commit = await first.commit({ message: "made a page" });

      expect(commit).toEqual({ status: "ok", changed: [APP] });

      // A different façade instance — the next turn's harness — sees it.
      const next = await workspace.open(user);
      expect(await next.readFile(APP)).toBe("page: hello");

      expect(await rowsFor(APP)).toEqual([
        { content: "page: hello", blob_ref: null, bytes: 11, revision: 1 },
      ]);
    });

    it("stages writes until commit, so a turn that never commits leaves no row", async () => {
      const path = "/user/memory/uncommitted.md";
      const fs = await workspaceStore(made.store).open(user);
      await fs.writeFile(path, "thinking out loud");
      // Visible to the turn...
      expect(await fs.readFile(path)).toBe("thinking out loud");
      // ...and absent from the store.
      expect(await rowsFor(path)).toEqual([]);
    });

    it("writes one row per changed file however many times the turn edits it", async () => {
      // The store write law (design §8): O(files changed), never O(writes).
      const path = "/user/apps/app_2/plan.vendo";
      const workspace = workspaceStore(made.store);
      const fs = await workspace.open(user);
      await fs.writeFile(path, "draft 0");
      await fs.commit();

      const editing = await workspace.open(user);
      for (let edit = 1; edit <= 40; edit += 1) await editing.writeFile(path, `draft ${edit}`);
      const commit = await editing.commit({ message: "rewrote the plan" });

      expect(commit).toEqual({ status: "ok", changed: [path] });
      // 41 writes, one revision bump, one history row — not 41 of either.
      expect(await rowsFor(path)).toEqual([
        { content: "draft 40", blob_ref: null, bytes: 8, revision: 2 },
      ]);
      const history = await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_workspace_history WHERE path = $1",
        [path],
      );
      expect(Number(history[0]?.["count"])).toBe(1);
    });

    it("skips a commit whose bytes did not change", async () => {
      const path = "/user/memory/same.md";
      const workspace = workspaceStore(made.store);
      const first = await workspace.open(user);
      await first.writeFile(path, "unchanged");
      await first.commit();

      const second = await workspace.open(user);
      await second.writeFile(path, "unchanged");
      expect(await second.commit()).toEqual({ status: "ok", changed: [] });
      expect(await rowsFor(path)).toEqual([
        { content: "unchanged", blob_ref: null, bytes: 9, revision: 1 },
      ]);
    });

    it("records prior content and the consumer-voice intent in history, and undo walks it back", async () => {
      const path = "/user/apps/app_3/app.vendo";
      const workspace = workspaceStore(made.store);
      for (const [colour, intent] of [
        ["red", "made the chart red"],
        ["blue", "made the chart blue"],
        ["green", "made the chart green"],
      ] as const) {
        const fs = await workspace.open(user);
        await fs.writeFile(path, `chart: ${colour}`);
        await fs.commit({ message: intent });
      }

      const history = await workspace.history(caller, path);
      expect(history.map((entry) => [entry.revision, entry.intent])).toEqual([
        [2, "made the chart green"],
        [1, "made the chart blue"],
      ]);

      const reader = async (): Promise<string> =>
        await (await workspace.open(user)).readFile(path);
      expect(await reader()).toBe("chart: green");

      // Each undo walks one step further back, never toggling between two.
      expect(await workspace.undo(caller, path)).toEqual({ status: "ok", revision: 4 });
      expect(await reader()).toBe("chart: blue");
      expect(await workspace.undo(caller, path)).toEqual({ status: "ok", revision: 5 });
      expect(await reader()).toBe("chart: red");
      // Nothing left to undo.
      expect(await workspace.undo(caller, path)).toEqual({ status: "empty" });
      expect(await reader()).toBe("chart: red");
    });

    it("keeps /host read-only for everyone and readable by all of them", async () => {
      const skill = "/host/skills/charting/SKILL.md";
      const fs = await workspaceStore(made.store).open(user, {
        host: { [skill]: "# Charting\nUse a bar chart for counts." },
      });

      expect(await fs.readFile(skill)).toContain("bar chart");
      expect(await fs.readdir("/host/skills")).toEqual(["charting"]);
      await expect(fs.writeFile(skill, "mine now")).rejects.toThrow(/EROFS: read-only file system/);
      await expect(fs.rm(skill)).rejects.toThrow(/EROFS: read-only file system/);
      expect(await rowsFor(skill)).toEqual([]);
    });

    it("never commits /user/scratch, though the turn reads and writes it freely", async () => {
      const scratch = "/user/scratch/notes.txt";
      const fs = await workspaceStore(made.store).open(user);
      await fs.writeFile(scratch, "intra-turn junk");
      await fs.writeFile("/user/files/keep.txt", "kept");
      expect(await fs.readFile(scratch)).toBe("intra-turn junk");

      expect(await fs.commit()).toEqual({ status: "ok", changed: ["/user/files/keep.txt"] });
      expect(await rowsFor(scratch)).toEqual([]);
    });

    it("commits a delete, and the deleted path is gone next turn", async () => {
      const path = "/user/files/temporary.txt";
      const workspace = workspaceStore(made.store);
      const first = await workspace.open(user);
      await first.writeFile(path, "here");
      await first.commit();

      const second = await workspace.open(user);
      await second.rm(path);
      expect(await second.commit()).toEqual({ status: "ok", changed: [path] });
      expect(await rowsFor(path)).toEqual([]);

      const third = await workspace.open(user);
      expect(await third.exists(path)).toBe(false);
    });

    it("keeps one subject's files out of another's workspace", async () => {
      const other: Principal = { kind: "user", subject: "user_ws_other" };
      const path = "/user/memory/private.md";
      const workspace = workspaceStore(made.store);
      const mine = await workspace.open(user);
      await mine.writeFile(path, "mine only");
      await mine.commit();

      const theirs = await workspace.open(other);
      expect(await theirs.exists(path)).toBe(false);
      expect(theirs.getAllPaths()).not.toContain(path);
    });

    it("sends a file past the inline cap to the files adapter, byte for byte", async () => {
      const path = "/user/files/big.txt";
      const big = "x".repeat(WORKSPACE_INLINE_MAX_BYTES + 1);
      const workspace = workspaceStore(made.store);
      const fs = await workspace.open(user);
      await fs.writeFile(path, big);
      await fs.commit();

      const row = (await rowsFor(path))[0];
      expect(row?.["content"]).toBeNull();
      expect(row?.["blob_ref"]).toMatch(/^wsb_[0-9a-f-]{36}$/);
      expect(Number(row?.["bytes"])).toBe(WORKSPACE_INLINE_MAX_BYTES + 1);
      expect(await (await workspace.open(user)).readFile(path)).toBe(big);
    });

    it("sends bytes that are not text to the files adapter whatever their size", async () => {
      const path = "/user/files/tiny.png";
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]);
      const workspace = workspaceStore(made.store);
      const fs = await workspace.open(user);
      await fs.writeFile(path, bytes);
      await fs.commit();

      const row = (await rowsFor(path))[0];
      expect(row?.["content"]).toBeNull();
      expect(row?.["blob_ref"]).toMatch(/^wsb_[0-9a-f-]{36}$/);
      expect(await (await workspace.open(user)).readFileBuffer(path)).toEqual(bytes);
    });

    it("puts over-cap bytes in a wired files adapter instead of the store", async () => {
      const held = new Map<string, Uint8Array>();
      const files = {
        async put(key: string, bytes: Uint8Array) { held.set(key, bytes); },
        async get(key: string) {
          const bytes = held.get(key);
          return bytes === undefined ? undefined : { bytes };
        },
        async delete(key: string) { held.delete(key); },
      };
      const path = "/user/files/wired.bin";
      const overCap = new Uint8Array(WORKSPACE_INLINE_MAX_BYTES + 1).fill(7);
      const blobCount = async (): Promise<number> => Number(
        (await made.sql("SELECT COUNT(*)::int AS count FROM vendo_blobs WHERE namespace = 'workspace'"))[0]?.["count"],
      );
      const before = await blobCount();

      const workspace = workspaceStore(made.store, { files });
      const fs = await workspace.open(user);
      await fs.writeFile(path, overCap);
      expect(await fs.commit()).toEqual({ status: "ok", changed: [path] });

      expect(held.size).toBe(1);
      const read = await (await workspace.open(user)).readFileBuffer(path);
      expect(Buffer.compare(Buffer.from(read), Buffer.from(overCap))).toBe(0);
      // The store's own blob table never saw it — the wired adapter took it.
      expect(await blobCount()).toBe(before);
    });

    it("strands no blob when undo discards a blob-backed revision", async () => {
      const path = "/user/files/big-history.txt";
      const workspace = workspaceStore(made.store);
      const big = (marker: string): string => marker.repeat(WORKSPACE_INLINE_MAX_BYTES + 1);
      for (const marker of ["a", "b"]) {
        const fs = await workspace.open(user);
        await fs.writeFile(path, big(marker));
        await fs.commit({ message: `wrote ${marker}` });
      }
      // Keys are random ids, so reachability is the question: how many blobs do
      // this path's rows still point at?
      const blobsFor = async (): Promise<number> => Number(
        (await made.sql(
          `SELECT COUNT(*)::int AS count FROM vendo_blobs
           WHERE namespace = 'workspace' AND key IN (
             SELECT blob_ref FROM vendo_workspace_files WHERE path = $1 AND blob_ref IS NOT NULL
             UNION SELECT blob_ref FROM vendo_workspace_history WHERE path = $1 AND blob_ref IS NOT NULL
           )`,
          [path],
        ))[0]?.["count"],
      );
      // One live revision + one superseded revision.
      expect(await blobsFor()).toBe(2);

      expect(await workspace.undo(caller, path)).toEqual({ status: "ok", revision: 3 });
      expect(await (await workspace.open(user)).readFile(path)).toBe(big("a"));
      // Undo has no redo, so the discarded revision's blob must not linger:
      // only the restored one is still referenced.
      expect(await blobsFor()).toBe(1);
    });

    it("keeps history to WORKSPACE_HISTORY_LIMIT revisions per path", async () => {
      const path = "/user/memory/chatty.md";
      const workspace = workspaceStore(made.store);
      for (let revision = 0; revision <= WORKSPACE_HISTORY_LIMIT + 5; revision += 1) {
        const fs = await workspace.open(user);
        await fs.writeFile(path, `revision ${revision}`);
        await fs.commit({ message: `edit ${revision}` });
      }
      const rows = await made.sql(
        `SELECT COUNT(*)::int AS count, MIN(revision)::int AS oldest, MAX(revision)::int AS newest
         FROM vendo_workspace_history WHERE path = $1`,
        [path],
      );
      expect(Number(rows[0]?.["count"])).toBe(WORKSPACE_HISTORY_LIMIT);
      // The newest revisions survive; the oldest are trimmed.
      expect(Number(rows[0]?.["newest"])).toBe(WORKSPACE_HISTORY_LIMIT + 5);
      expect(Number(rows[0]?.["oldest"])).toBe(6);
    });

    // F5 (verifier): commit wrote files in insertion order and aborted on the
    // first failure, so an oversized upload staged BEFORE the app edit silently
    // dropped the edit — and staged AFTER it, kept it. Order decided the data.
    it("commits nothing when one staged file cannot be stored, whatever the order", async () => {
      const app = "/user/apps/app_preflight/app.vendo";
      const upload = "/user/files/too-big.bin";
      const workspace = workspaceStore(made.store);

      for (const uploadFirst of [true, false]) {
        const fs = await workspace.open(user);
        if (uploadFirst) {
          await fs.writeFile(upload, new Uint8Array(FILES_STORE_MAX_BYTES + 1));
          await fs.writeFile(app, "page: survives");
        } else {
          await fs.writeFile(app, "page: survives");
          await fs.writeFile(upload, new Uint8Array(FILES_STORE_MAX_BYTES + 1));
        }

        // Rejected up front, naming the file that cannot be stored...
        await expect(fs.commit({ message: "tried both" }))
          .rejects.toMatchObject<Partial<VendoError>>({ code: "validation" });
        await expect(fs.commit()).rejects.toThrow(new RegExp(upload));
        // ...and no row landed for EITHER path, in either order.
        expect(await rowsFor(app)).toEqual([]);
        expect(await rowsFor(upload)).toEqual([]);
      }
    });

    it("leaves no orphaned content behind when a commit is rejected", async () => {
      const workspace = workspaceStore(made.store);
      const fs = await workspace.open(user);
      const blobs = async (): Promise<number> => Number(
        (await made.sql(
          "SELECT COUNT(*)::int AS count FROM vendo_blobs WHERE namespace = 'workspace'",
        ))[0]?.["count"],
      );
      const before = await blobs();

      // A storable over-cap-for-inline file (goes to a blob) plus an unstorable one.
      await fs.writeFile("/user/files/fine.txt", "y".repeat(WORKSPACE_INLINE_MAX_BYTES + 1));
      await fs.writeFile("/user/files/doomed.bin", new Uint8Array(FILES_STORE_MAX_BYTES + 1));
      await expect(fs.commit()).rejects.toThrow(/doomed\.bin/);

      // The blob placed for the storable file is released with the rejection.
      expect(await blobs()).toBe(before);
    });

    // N10 (verifier): the reject-cleanup loop was unguarded, so on a bucket with
    // no DeleteObject the FIRST cleanup failure replaced the real diagnosis and
    // aborted the rest of the cleanup.
    it("surfaces the real rejection even when releasing content also fails", async () => {
      const attempted: string[] = [];
      const files = {
        async put(key: string, bytes: Uint8Array) {
          if (bytes.byteLength > WORKSPACE_INLINE_MAX_BYTES * 2) {
            throw new VendoError("blocked", "bucket policy refused this object");
          }
          attempted.push(key);
        },
        async get() { return undefined; },
        async delete() { throw new Error("DeleteObject is not permitted on this bucket"); },
      };
      const fs = await workspaceStore(made.store, { files }).open(user);
      // Two placeable files, then one the bucket refuses.
      await fs.writeFile("/user/files/one.bin", new Uint8Array(WORKSPACE_INLINE_MAX_BYTES + 1));
      await fs.writeFile("/user/files/two.bin", new Uint8Array(WORKSPACE_INLINE_MAX_BYTES + 1));
      await fs.writeFile("/user/files/refused.bin", new Uint8Array(WORKSPACE_INLINE_MAX_BYTES * 2 + 1));

      const rejection = await fs.commit().catch((error: unknown) => error);
      // The real diagnosis survives — the bucket policy, not the cleanup failure.
      expect(rejection).toMatchObject<Partial<VendoError>>({ code: "blocked" });
      expect(String(rejection)).toContain("bucket policy refused");
      expect(String(rejection)).toContain("refused.bin");
      // Cleanup was attempted for BOTH placed files, not abandoned after the first.
      expect(attempted).toHaveLength(2);
      // And the cleanup trouble is still reported, as secondary detail.
      expect((rejection as VendoError).detail).toMatchObject({
        cleanupFailures: expect.arrayContaining([expect.stringContaining("DeleteObject")]),
      });
    });

    // N11 (verifier): commit() re-wrapped every placement failure as
    // "validation", defeating the adapter's own error mapping.
    it("keeps the adapter's error kind when a commit is rejected", async () => {
      const refusing = {
        async put() { throw new VendoError("blocked", "credentials refused"); },
        async get() { return undefined; },
        async delete() { /* nothing was ever stored */ },
      };
      const fs = await workspaceStore(made.store, { files: refusing }).open(user);
      await fs.writeFile("/user/files/big.bin", new Uint8Array(WORKSPACE_INLINE_MAX_BYTES + 1));
      await expect(fs.commit()).rejects.toMatchObject<Partial<VendoError>>({ code: "blocked" });

      const unavailable = {
        async put() { throw new VendoError("not-found", "no such bucket"); },
        async get() { return undefined; },
        async delete() { /* nothing was ever stored */ },
      };
      const other = await workspaceStore(made.store, { files: unavailable }).open(user);
      await other.writeFile("/user/files/big.bin", new Uint8Array(WORKSPACE_INLINE_MAX_BYTES + 1));
      await expect(other.commit()).rejects.toMatchObject<Partial<VendoError>>({ code: "not-found" });
    });

    // F6 (verifier): an explicitly mkdir'ed directory was reported as a file, so
    // `find -type f` returned directories.
    it("reports an explicitly created directory as a directory", async () => {
      const fs = await workspaceStore(made.store).open(user);
      await fs.mkdir("/user/files/reports", { recursive: true });
      await fs.writeFile("/user/files/summary.txt", "a file");

      const entries = await fs.readdirWithFileTypes("/user/files");
      expect(entries.find((entry) => entry.name === "reports"))
        .toMatchObject({ isDirectory: true, isFile: false });
      expect(entries.find((entry) => entry.name === "summary.txt"))
        .toMatchObject({ isDirectory: false, isFile: true });
      expect((await fs.stat("/user/files/reports")).isDirectory).toBe(true);
    });

    // N5 (verifier): a name that was both a file and a directory prefix came
    // back TWICE from readdir, so bash globs processed it twice — and nothing
    // stopped a write from creating that state in the first place.
    it("refuses to write through an existing file and never lists a name twice", async () => {
      const fs = await workspaceStore(made.store).open(user);
      await fs.writeFile("/user/files/report", "I am a file");

      // A file cannot become a directory by writing underneath it.
      await expect(fs.writeFile("/user/files/report/page.txt", "child"))
        .rejects.toThrow(/ENOTDIR: not a directory/);
      await expect(fs.mkdir("/user/files/report/nested", { recursive: true }))
        .rejects.toThrow(/ENOTDIR: not a directory/);

      const names = (await fs.readdir("/user/files")).filter((name) => name === "report");
      expect(names).toEqual(["report"]);
      const entries = (await fs.readdirWithFileTypes("/user/files"))
        .filter((entry) => entry.name === "report");
      expect(entries).toEqual([
        { name: "report", isFile: true, isDirectory: false, isSymbolicLink: false },
      ]);
    });

    // N5, second half: the write guard cannot police the /host projection (its
    // paths never pass through a write), so a caller CAN hand in a file and a
    // directory with the same name. readdir must still answer once.
    it("lists a projected name once even when it is both a file and a directory", async () => {
      const fs = await workspaceStore(made.store).open(user, {
        host: {
          "/host/skills/charting": "a file called charting",
          "/host/skills/charting/SKILL.md": "# Charting",
        },
      });

      expect(await fs.readdir("/host/skills")).toEqual(["charting"]);
      expect((await fs.readdirWithFileTypes("/host/skills")).map((entry) => entry.name))
        .toEqual(["charting"]);
    });

    // F7 (verifier): rm erased the path's whole history, so a deleted file could
    // never be undone — contract §3.3 says history is append-only.
    it("records a delete in history so undo brings the file back", async () => {
      const path = "/user/files/deleted-then-restored.txt";
      const workspace = workspaceStore(made.store);
      const first = await workspace.open(user);
      await first.writeFile(path, "the only copy");
      await first.commit({ message: "wrote it" });

      const second = await workspace.open(user);
      await second.rm(path);
      expect(await second.commit({ message: "deleted the file" })).toEqual({
        status: "ok",
        changed: [path],
      });
      expect(await rowsFor(path)).toEqual([]);

      // History kept what the delete removed, with the delete's own intent.
      expect(await workspace.history(caller, path)).toMatchObject([
        { revision: 1, intent: "deleted the file" },
      ]);

      expect(await workspace.undo(caller, path)).toMatchObject({ status: "ok" });
      expect(await (await workspace.open(user)).readFile(path)).toBe("the only copy");
      // Revisions never go backwards, even across a delete and a restore.
      expect(Number((await rowsFor(path))[0]?.["revision"])).toBeGreaterThan(1);
    });

    // F10 (verifier): writes outside the two mounts were staged and then
    // silently discarded with status ok — data loss on a typo.
    it("refuses a write outside the two mounts instead of dropping it at commit", async () => {
      const fs = await workspaceStore(made.store).open(user);
      for (const path of ["/User/apps/app_1/app.vendo", "/user/../x", "/etc/passwd", "/tmp/scratch.txt"]) {
        await expect(fs.writeFile(path, "lost?")).rejects.toThrow(/EACCES: permission denied/);
      }
      await expect(fs.mkdir("/etc/vendo")).rejects.toThrow(/EACCES: permission denied/);
      expect(await fs.commit()).toEqual({ status: "ok", changed: [] });
    });

    // F13 (verifier): a file literally named /user/scratch persisted and
    // shadowed the scratch directory.
    it("treats the bare /user/scratch path as scratch, not a persisted file", async () => {
      const fs = await workspaceStore(made.store).open(user);
      await fs.writeFile("/user/scratch", "not a real document");
      expect(await fs.commit()).toEqual({ status: "ok", changed: [] });
      expect(await rowsFor("/user/scratch")).toEqual([]);
    });

    // N4 (verifier): the F8 fix CONSUMED the unreadable history row, so a host
    // that restarts pointed at the wrong bucket destroyed the entire undo
    // history of every path the user tried to recover — unrecoverably.
    // Invariant: a history row is only ever deleted once its content was
    // actually restored, or explicitly discarded.
    it("destroys no history when every revision's content is unreachable", async () => {
      const path = "/user/files/wrong-bucket.txt";
      const workspace = workspaceStore(made.store);
      const big = (marker: string): string => marker.repeat(WORKSPACE_INLINE_MAX_BYTES + 1);
      for (const content of [big("a"), big("b"), big("c")]) {
        const fs = await workspace.open(user);
        await fs.writeFile(path, content);
        await fs.commit({ message: "wrote" });
      }
      const historyBefore = await workspace.history(caller, path);
      expect(historyBefore).toHaveLength(2);

      // Every workspace blob vanishes — the shape of pointing at the wrong bucket.
      await made.sql("DELETE FROM vendo_blobs WHERE namespace = 'workspace'");

      // Reported as an adapter fault, naming the revisions it could not read...
      const first = await workspace.undo(caller, path);
      expect(first).toMatchObject({ status: "content-missing" });
      expect(first).toMatchObject({ revisions: [2, 1] });
      // ...and repeating it changes nothing: the history is still all there.
      expect(await workspace.undo(caller, path)).toMatchObject({ status: "content-missing" });
      expect(await workspace.history(caller, path)).toEqual(historyBefore);
    });

    // F8 (verifier): a revision whose blob had vanished reported "empty" — a lie
    // that also wedged every older revision behind it. Under N4's invariant the
    // walk steps over it in ONE undo and leaves the row intact.
    it("steps over a revision whose content is gone, naming it and keeping it", async () => {
      const path = "/user/files/lost-blob.txt";
      const workspace = workspaceStore(made.store);
      const big = (marker: string): string => marker.repeat(WORKSPACE_INLINE_MAX_BYTES + 1);
      for (const content of [big("a"), big("b"), big("c")]) {
        const fs = await workspace.open(user);
        await fs.writeFile(path, content);
        await fs.commit({ message: "wrote" });
      }
      // Lose the content of the newest superseded revision behind the store's back.
      const ref = String((await made.sql(
        `SELECT blob_ref FROM vendo_workspace_history WHERE path = $1
         ORDER BY revision DESC LIMIT 1`,
        [path],
      ))[0]?.["blob_ref"]);
      await made.sql("DELETE FROM vendo_blobs WHERE namespace = 'workspace' AND key = $1", [ref]);
      const missingRevision = Number((await made.sql(
        `SELECT revision FROM vendo_workspace_history WHERE path = $1
         ORDER BY revision DESC LIMIT 1`,
        [path],
      ))[0]?.["revision"]);

      // One step: over the unreadable revision and onto the one that works,
      // saying which it skipped rather than pretending nothing happened.
      expect(await workspace.undo(caller, path))
        .toMatchObject({ status: "ok", skipped: [missingRevision] });
      expect(await (await workspace.open(user)).readFile(path)).toBe(big("a"));
      // The unreadable revision was stepped over, not destroyed.
      expect((await workspace.history(caller, path)).map((entry) => entry.revision))
        .toContain(missingRevision);
    });

    // N1/N2 (verifier): two commits touching one path both reserved revision
    // N+1, so the loser's edit was destroyed while it was told `ok`, history
    // carried duplicate revision numbers (undo degenerated into the toggle the
    // design forbids), and the loser's blob orphaned. §3.5's mid-turn hot-path
    // sync makes overlapping commits a designed-for case, not a hypothetical.
    it("lands overlapping commits on one path as distinct monotonic revisions", async () => {
      const path = "/user/apps/app_race/app.vendo";
      const workspace = workspaceStore(made.store);
      const seed = await workspace.open(user);
      await seed.writeFile(path, "chart: base");
      await seed.commit({ message: "the base" });

      const [left, right] = [await workspace.open(user), await workspace.open(user)];
      await left.writeFile(path, "chart: from left");
      await right.writeFile(path, "chart: from right");

      const outcomes = await Promise.all([
        left.commit({ message: "left" }),
        right.commit({ message: "right" }),
      ]);
      expect(outcomes).toEqual([
        { status: "ok", changed: [path] },
        { status: "ok", changed: [path] },
      ]);

      // Last write wins for the FINAL content...
      const settled = await (await workspace.open(user)).readFile(path);
      expect(["chart: from left", "chart: from right"]).toContain(settled);

      // ...but neither edit vanished: revisions are unique and monotonic.
      const revisions = (await made.sql(
        "SELECT revision FROM vendo_workspace_history WHERE path = $1 ORDER BY revision ASC",
        [path],
      )).map((row) => Number(row["revision"]));
      expect(revisions).toEqual([...new Set(revisions)]);
      expect(revisions).toEqual([1, 2]);
      const live = Number((await rowsFor(path))[0]?.["revision"]);
      expect(live).toBe(3);

      // Undo walks back through the loser's edit to the base, never toggling.
      const loser = settled === "chart: from left" ? "chart: from right" : "chart: from left";
      expect(await workspace.undo(caller, path)).toMatchObject({ status: "ok" });
      expect(await (await workspace.open(user)).readFile(path)).toBe(loser);
      expect(await workspace.undo(caller, path)).toMatchObject({ status: "ok" });
      expect(await (await workspace.open(user)).readFile(path)).toBe("chart: base");
    });

    // N7 (verifier): the mirror of N1/N2, through undo. undo released the
    // superseded blob BEFORE its compare-and-swap, so a lost undo race deleted
    // content that a concurrent writer's history row now pointed at —
    // permanent, unrecoverable loss reported forever as content-missing, the
    // exact mode N4 exists to prevent, reached through a different door.
    it("destroys no content when an undo loses its race to a concurrent writer", async () => {
      const path = "/user/files/undo-race.bin";
      const workspace = workspaceStore(made.store);
      const big = (marker: string): string => marker.repeat(WORKSPACE_INLINE_MAX_BYTES + 1);

      // Reach the repro's state: live r2 (blob K_b), history r1 (blob K_a).
      for (const content of [big("a"), big("b")]) {
        const fs = await workspace.open(user);
        await fs.writeFile(path, content);
        await fs.commit({ message: "wrote" });
      }

      // A writer prepared against r2, held until the undo is mid-flight.
      const writer = await workspace.open(user);
      await writer.writeFile(path, big("c"));

      // Force the interleave: undo's compare-and-swap is the one carrying
      // recordHistory=false (its last SQL param). Just before it runs, land the
      // writer — so it supersedes r2, writing a history row that points at K_b,
      // in the window where undo had already released K_b under the old order.
      const db = dbFor(made.store);
      const original = db.query.bind(db);
      let landedWriter = false;
      db.query = async (text: string, params?: unknown[]) => {
        if (!landedWriter && text.includes("WITH swapped AS") && params?.[params.length - 1] === false) {
          landedWriter = true;
          await writer.commit({ message: "the racing writer" });
        }
        return original(text, params);
      };
      try {
        // undo restores r1 (K_a) but loses its first CAS to the writer, re-aims,
        // and wins — dropping only the content it actually superseded.
        expect(await workspace.undo(caller, path)).toMatchObject({ status: "ok" });
      } finally {
        db.query = original;
      }
      expect(landedWriter).toBe(true);

      // No history row may reference a blob that is gone: the writer's r2 → K_b
      // row must still be readable, or the content is lost forever.
      const dangling = await made.sql(
        `SELECT h.blob_ref FROM vendo_workspace_history h
         WHERE h.blob_ref IS NOT NULL AND h.path = $1
           AND NOT EXISTS (
             SELECT 1 FROM vendo_blobs b WHERE b.namespace = 'workspace' AND b.key = h.blob_ref
           )`,
        [path],
      );
      expect(dangling).toEqual([]);

      // And the writer's revision is genuinely recoverable, not content-missing.
      const recovered = await workspace.undo(caller, path);
      expect(recovered).toMatchObject({ status: "ok" });
      expect(await (await workspace.open(user)).readFile(path)).toBe(big("b"));
    });

    // The other half of N7, and the worse one: undo hands its history row's
    // BLOB straight to the live row rather than re-uploading the bytes. Two
    // undos of the same revision therefore both hold the key the winner just
    // made the live file's only copy — and the loser's "the winner stored
    // exactly these bytes, so our blob is surplus" branch deletes it. The row
    // survives pointing at nothing, so the file is unreadable forever with no
    // history row left naming it.
    it("keeps the restored file readable when a second undo lands on the same revision", async () => {
      const path = "/user/files/undo-twice.bin";
      const workspace = workspaceStore(made.store);
      const big = (marker: string): string => marker.repeat(WORKSPACE_INLINE_MAX_BYTES + 1);

      // Live r2 (blob K_b), history r1 (blob K_a).
      for (const content of [big("a"), big("b")]) {
        const fs = await workspace.open(user);
        await fs.writeFile(path, content);
        await fs.commit({ message: "wrote" });
      }

      // Force the interleave: an undo's compare-and-swap is the one carrying
      // recordHistory=false (its last SQL param). Just before the FIRST one
      // runs, run a whole second undo to completion — so it wins the swap and
      // K_a becomes the live row's blob, and the one already in flight then
      // finds a head holding exactly the bytes it was about to write.
      const db = dbFor(made.store);
      const original = db.query.bind(db);
      let winner = false;
      db.query = async (text: string, params?: unknown[]) => {
        if (!winner && text.includes("WITH swapped AS") && params?.[params.length - 1] === false) {
          winner = true;
          await workspace.undo(caller, path);
        }
        return original(text, params);
      };
      try {
        await workspace.undo(caller, path);
      } finally {
        db.query = original;
      }
      expect(winner).toBe(true);

      // The live row must not point at a blob that is gone.
      const dangling = await made.sql(
        `SELECT f.blob_ref FROM vendo_workspace_files f
         WHERE f.blob_ref IS NOT NULL AND f.path = $1
           AND NOT EXISTS (
             SELECT 1 FROM vendo_blobs b WHERE b.namespace = 'workspace' AND b.key = f.blob_ref
           )`,
        [path],
      );
      expect(dangling).toEqual([]);
      expect(await (await workspace.open(user)).readFile(path)).toBe(big("a"));
    });

    it("strands no blob when overlapping commits race on one blob-backed path", async () => {
      const path = "/user/files/raced-big.bin";
      const workspace = workspaceStore(made.store);
      const big = (marker: number): Uint8Array =>
        new Uint8Array(WORKSPACE_INLINE_MAX_BYTES + 1).fill(marker);
      const reachable = async (): Promise<number> => Number(
        (await made.sql(
          `SELECT COUNT(*)::int AS count FROM vendo_blobs WHERE namespace = 'workspace'
             AND key NOT IN (
               SELECT blob_ref FROM vendo_workspace_files WHERE blob_ref IS NOT NULL
               UNION SELECT blob_ref FROM vendo_workspace_history WHERE blob_ref IS NOT NULL
             )`,
        ))[0]?.["count"],
      );
      const orphansBefore = await reachable();

      const [left, right] = [await workspace.open(user), await workspace.open(user)];
      await left.writeFile(path, big(1));
      await right.writeFile(path, big(2));
      await Promise.all([left.commit({ message: "left" }), right.commit({ message: "right" })]);

      // Every workspace blob is still pointed at by some row.
      expect(await reachable()).toBe(orphansBefore);
    });

    it("names the fix when a file passes the store-backed cap with no files adapter wired", async () => {
      const fs = await workspaceStore(made.store).open(user);
      await fs.writeFile("/user/files/huge.bin", new Uint8Array(FILES_STORE_MAX_BYTES + 1));
      await expect(fs.commit()).rejects.toMatchObject<Partial<VendoError>>({ code: "validation" });
      await expect(fs.commit()).rejects.toThrow(/Wire `files:`/);
    });
  });
}

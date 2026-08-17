import { describe, expect, it } from "vitest";
import { memoryStoreOps, storeOpsConformance } from "../../src/conformance/index.js";
import { engineAppHistory } from "../../src/engine-collections.js";
import { VendoError } from "../../src/errors.js";
import type { IsoDateTime } from "../../src/ids.js";
import type { StoreOps, VendoRecord } from "../../src/store.js";

/**
 * Every case in the StoreOps kit is a claim that some specific mistake would be
 * caught. A case that has only ever been run against implementations that
 * happen to be correct proves nothing about that claim — it may assert the
 * wrong thing, or nothing at all, and the day a second implementation arrives
 * the suite's silence is indistinguishable from its approval.
 *
 * So each case added by the conformance-hardening lane is run here against a
 * memory reference with exactly ONE rule broken, and asserted to go red for the
 * reason it was written for. The message is asserted too: a case that fails for
 * an unrelated reason is not the same as a case that caught its own bug.
 *
 * The CONCURRENCY flaws deserve a note. `memoryStoreOps` does its work without
 * a single `await` inside any verb, so two calls fired at one instant run to
 * completion one after the other and no race is observable — which is why the
 * raced cases pass against it, and against PGlite's single connection, without
 * proving anything there. The flaws below put the `await` back exactly where a
 * real implementation has one: between the read and the write that depends on
 * it. That window is the whole bug, on every engine that has more than one
 * connection, and these are the only runs in the repo that open it on purpose.
 */

type Flaw =
  | "claimReadsThenWrites"
  | "claimDeleteDoesNothing"
  | "insertReadsThenWrites"
  | "swapReadsThenWrites"
  | "refsMatchOnKeyAlone"
  | "listingForgetsItsNamespace"
  | "emptyBytesAreAbsence"
  | "appsShareOneDrawer"
  | "pageTwoForgetsTheOwner"
  | "eraseByAppIsAReceipt"
  | "appendSortsTheBatch"
  | "appendNeverEdits"
  | "appendAcceptsAnEmptyBatch"
  | "appendQuietlyDropsADuplicateId"
  | "appendRefusesAThreadItShouldCreate"
  | "appendRevisionNeverMoves"
  | "commitIgnoresItsGuard"
  | "commitForgetsTheKey"
  | "keyIgnoresItsOwner"
  | "conflictCarriesNoDetail"
  | "workspaceNormalisesContent"
  | "readOfNoPathsRefuses"
  | "emptyCommitIsAccepted"
  | "indexDefaultsElsewhere";

/** A message id nobody would collide with, so `appendNeverEdits` really appends. */
let nonce = 0;

/** One flat table of one-rule breakages. Deliberately not split into per-family
    factories: the point is that each arm is small enough to read as "this and
    only this is wrong", and an indirection between the flaw and its name would
    cost exactly that. */
function broken(flaw: Flaw): StoreOps {
  const ops = memoryStoreOps();
  const append = ops.transcripts.appendMessages!;
  const yieldToTheOther = async (): Promise<void> => { await Promise.resolve(); };

  switch (flaw) {
    // ---- engine ---------------------------------------------------------
    case "claimReadsThenWrites":
      return { ...ops, engine: { ...ops.engine, async claim(collection, expected, replacement) {
        const current = await ops.engine.get(collection, expected.id);
        const matches = current !== null && JSON.stringify(current.data) === JSON.stringify(expected.data);
        await yieldToTheOther(); // the window a second caller lands in
        if (!matches) return false;
        if (replacement === undefined) await ops.engine.delete(collection, expected.id);
        else await ops.engine.put(collection, { id: expected.id, data: replacement.data, refs: replacement.refs });
        return true;
      } } };
    case "claimDeleteDoesNothing":
      return { ...ops, engine: { ...ops.engine, async claim(collection, expected, replacement) {
        if (replacement === undefined) return true; // a release that reports success and releases nothing
        return await ops.engine.claim(collection, expected, replacement);
      } } };
    case "insertReadsThenWrites":
      return { ...ops, engine: { ...ops.engine, async insertIfAbsent(collection, record) {
        const held = await ops.engine.get(collection, record.id);
        await yieldToTheOther();
        return held === null ? await ops.engine.put(collection, record) : null;
      } } };
    case "swapReadsThenWrites":
      return { ...ops, engine: { ...ops.engine, async compareAndSwap(collection, record, expectedRevision) {
        const held = await ops.engine.get(collection, record.id);
        await yieldToTheOther();
        return held?.revision === expectedRevision ? await ops.engine.put(collection, record) : null;
      } } };
    case "refsMatchOnKeyAlone":
      return { ...ops, engine: { ...ops.engine, async list(collection, query) {
        if (query?.refs === undefined) return await ops.engine.list(collection, query);
        const { refs, ...rest } = query;
        const page = await ops.engine.list(collection, rest);
        return { ...page, records: page.records.filter((r) => Object.keys(refs).every((k) => r.refs?.[k] !== undefined)) };
      } } };

    // ---- blobs ----------------------------------------------------------
    case "listingForgetsItsNamespace":
      return { ...ops, blobs: { ...ops.blobs, async list(_namespace, prefix) {
        const namespaces = ["conf_ns_a", "conf_ns_b", "conf_ns_c"];
        const all = await Promise.all(namespaces.map((n) => ops.blobs.list(n, prefix)));
        return [...new Set(all.flat())];
      } } };
    case "emptyBytesAreAbsence":
      return { ...ops, blobs: { ...ops.blobs, async put(namespace, key, bytes, meta) {
        if (bytes.length === 0) return; // a successful put that stored nothing
        await ops.blobs.put(namespace, key, bytes, meta);
      } } };

    // ---- appData --------------------------------------------------------
    case "appsShareOneDrawer": {
      const flatten = <T>(target: { appId: string }, run: (t: never) => Promise<T>): Promise<T> =>
        run({ ...target, appId: "one_drawer" } as never);
      return { ...ops, appData: {
        ...ops.appData,
        put: (target, record) => flatten(target, (t) => ops.appData.put(t, record)),
        get: (target, id) => flatten(target, (t) => ops.appData.get(t, id)),
        list: (target, query) => flatten(target, (t) => ops.appData.list(t, query)),
        delete: (target, id) => flatten(target, (t) => ops.appData.delete(t, id)),
        putFile: (target, key, bytes, meta) => flatten(target, (t) => ops.appData.putFile(t, key, bytes, meta)),
        getFile: (target, key) => flatten(target, (t) => ops.appData.getFile(t, key)),
        deleteFile: (target, key) => flatten(target, (t) => ops.appData.deleteFile(t, key)),
      } } as StoreOps;
    }
    case "pageTwoForgetsTheOwner":
      return { ...ops, appData: { ...ops.appData, async list(target, query) {
        if (query?.cursor === undefined) return await ops.appData.list(target, query);
        return await ops.appData.list({ ...target, owner: "own_b" }, query);
      } } };

    // ---- lifecycle ------------------------------------------------------
    case "eraseByAppIsAReceipt":
      return { ...ops, lifecycle: { ...ops.lifecycle, async erase(target) {
        if (target.appId !== undefined) return { erased: true }; // a receipt for work never done
        return await ops.lifecycle.erase(target);
      } } };

    // ---- transcripts ----------------------------------------------------
    case "appendSortsTheBatch":
      return { ...ops, transcripts: { ...ops.transcripts, appendMessages: (threadId, subject, messages, opts) =>
        append(threadId, subject, [...messages].sort((a, b) =>
          String((a as { id?: unknown }).id) < String((b as { id?: unknown }).id) ? -1 : 1), opts) } };
    case "appendNeverEdits":
      return { ...ops, transcripts: { ...ops.transcripts, appendMessages: (threadId, subject, messages, opts) =>
        append(threadId, subject, messages.map((message) => {
          nonce += 1;
          return { ...(message as object), id: `${String((message as { id?: unknown }).id)}#${nonce}` };
        }), opts) } };
    case "appendAcceptsAnEmptyBatch":
      return { ...ops, transcripts: { ...ops.transcripts, appendMessages: async (threadId, subject, messages, opts) =>
        messages.length === 0 ? { revision: "0", count: 0 } : await append(threadId, subject, messages, opts) } };
    case "appendQuietlyDropsADuplicateId":
      return { ...ops, transcripts: { ...ops.transcripts, appendMessages: (threadId, subject, messages, opts) => {
        // De-duplicating instead of refusing: the caller believes both landed.
        const seen = new Set<string>();
        return append(threadId, subject, messages.filter((message) => {
          const id = String((message as { id?: unknown }).id);
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        }), opts);
      } } };
    case "appendRefusesAThreadItShouldCreate":
      return { ...ops, transcripts: { ...ops.transcripts, appendMessages: async (threadId, subject, messages, opts) => {
        if (await ops.transcripts.getThread(threadId) === null) {
          throw new VendoError("not-found", `thread ${threadId} not found`);
        }
        return await append(threadId, subject, messages, opts);
      } } };
    case "appendRevisionNeverMoves":
      return { ...ops, transcripts: { ...ops.transcripts, appendMessages: async (threadId, subject, messages, opts) =>
        ({ ...(await append(threadId, subject, messages, opts)), revision: "1" }) } };

    // ---- workspace ------------------------------------------------------
    case "commitIgnoresItsGuard":
      return { ...ops, workspace: { ...ops.workspace, commit: (entries, opts) =>
        ops.workspace.commit(entries.map((entry) => {
          const { expectedRevision: _dropped, ...rest } = entry as Record<string, unknown>;
          return rest;
        }), opts) } };
    case "commitForgetsTheKey":
      return { ...ops, workspace: { ...ops.workspace, commit: (entries, opts) =>
        ops.workspace.commit(entries, opts?.owner === undefined ? {} : { owner: opts.owner }) } };
    case "keyIgnoresItsOwner": {
      // One ledger for every owner, keyed on the key alone — the shape
      // `IdempotencyScope`'s `tenant` field exists to forbid.
      const ledger = new Map<string, string>();
      return { ...ops, workspace: { ...ops.workspace, async commit(entries, opts) {
        const key = opts?.idempotencyKey;
        if (key === undefined) return await ops.workspace.commit(entries, opts);
        const body = JSON.stringify(entries);
        const held = ledger.get(key);
        if (held === body) return;
        if (held !== undefined) throw new VendoError("conflict", `idempotency key ${key} was already used for different entries`);
        ledger.set(key, body);
        return await ops.workspace.commit(entries, opts?.owner === undefined ? {} : { owner: opts.owner });
      } } };
    }
    case "conflictCarriesNoDetail":
      return { ...ops, workspace: { ...ops.workspace, async commit(entries, opts) {
        try {
          return await ops.workspace.commit(entries, opts);
        } catch (error) {
          throw new VendoError((error as VendoError).code, (error as Error).message);
        }
      } } };
    case "workspaceNormalisesContent":
      return { ...ops, workspace: { ...ops.workspace, commit: (entries, opts) =>
        ops.workspace.commit(entries.map((entry) => {
          const data = (entry as { data?: unknown }).data as { $vendoWorkspaceBytes?: unknown } | undefined;
          if (data?.$vendoWorkspaceBytes === undefined) return entry;
          // A store that models content as a struct it knows, and loses the rest.
          return { ...(entry as object), data: { $vendoWorkspaceBytes: data.$vendoWorkspaceBytes } };
        }), opts) } };
    case "readOfNoPathsRefuses":
      return { ...ops, workspace: { ...ops.workspace, async read(paths, opts) {
        if (paths.length === 0) throw new VendoError("validation", "workspace.read needs at least one path");
        return await ops.workspace.read(paths, opts);
      } } };
    case "emptyCommitIsAccepted":
      return { ...ops, workspace: { ...ops.workspace, async commit(entries, opts) {
        if (entries.length === 0) return;
        await ops.workspace.commit(entries, opts);
      } } };
    case "indexDefaultsElsewhere":
      return { ...ops, workspace: { ...ops.workspace, index: (query) =>
        ops.workspace.index({ ...query, owner: query?.owner ?? "some_other_default" }) } };
  }
}

/** The one case a flaw is supposed to break, and the assertion that must fire. */
const proofs: Array<{ flaw: Flaw; case: string; red: RegExp }> = [
  { flaw: "claimReadsThenWrites", case: "engine.claim under a real race lets exactly one caller win", red: /exactly one of two simultaneous claims may win, 2 did/ },
  { flaw: "claimDeleteDoesNothing", case: "engine.claim with no replacement deletes exactly the row it matched", red: /the claimed row was not deleted/ },
  { flaw: "insertReadsThenWrites", case: "engine.insertIfAbsent admits exactly one of four simultaneous writers", red: /exactly one of four simultaneous inserts may be admitted, 4 were/ },
  { flaw: "swapReadsThenWrites", case: "engine.compareAndSwap lands exactly one of two swaps off one revision", red: /exactly one swap off one revision may land, 2 did/ },
  { flaw: "refsMatchOnKeyAlone", case: "engine.list narrows by refs, exactly and ANDed", red: /a one-key ref filter returned the wrong rows/ },
  { flaw: "listingForgetsItsNamespace", case: "blobs keep two namespaces apart on every verb", red: /a namespace listed a neighbour's keys/ },
  { flaw: "emptyBytesAreAbsence", case: "blobs round-trip a zero-byte payload as content, not absence", red: /a stored zero-byte blob read back as absent/ },
  { flaw: "appsShareOneDrawer", case: "appData keeps two apps' drawers apart", red: /one app read another app's row/ },
  { flaw: "pageTwoForgetsTheOwner", case: "appData.list paginates one owner's drawer without loss, duplicates, or a neighbour's rows", red: /appData\.list: pagination (omitted or added entries|.* appeared on more than one page)/ },
  { flaw: "eraseByAppIsAReceipt", case: "lifecycle.erase removes one app's data, and only that app's", red: /erase left the app's rows behind/ },
  { flaw: "appendSortsTheBatch", case: "transcripts.appendMessages lands a batch after the tail, in the caller's order", red: /did not land after the tail in the order they were written/ },
  { flaw: "appendNeverEdits", case: "transcripts.appendMessages edits an id the thread already holds, without moving it", red: /appended again, or moved, instead of edited in place/ },
  { flaw: "appendAcceptsAnEmptyBatch", case: "transcripts.appendMessages refuses an empty batch and two messages under one id", red: /an empty batch did not throw/ },
  { flaw: "appendQuietlyDropsADuplicateId", case: "transcripts.appendMessages refuses an empty batch and two messages under one id", red: /two messages sharing one id did not throw/ },
  { flaw: "appendRefusesAThreadItShouldCreate", case: "transcripts.appendMessages creates a thread that does not exist yet, under the named subject", red: /thread thr_new not found/ },
  { flaw: "appendRevisionNeverMoves", case: "transcripts.appendMessages reports a revision that moves with every batch", red: /reported a revision an earlier one already used/ },
  { flaw: "commitIgnoresItsGuard", case: "workspace.commit lands exactly one of two simultaneous compare-and-swaps", red: /exactly one commit off one revision may land, 2 did/ },
  { flaw: "commitForgetsTheKey", case: "workspace.commit replays a double-fired idempotency key once it has an answer", red: /a replay after the key already had an answer committed again/ },
  { flaw: "keyIgnoresItsOwner", case: "workspace.commit's idempotency key is scoped to its owner", red: /idempotency key shared_key was already used for different entries/ },
  { flaw: "conflictCarriesNoDetail", case: "workspace.commit's conflict names the paths it refused on", red: /carried no detail/ },
  { flaw: "workspaceNormalisesContent", case: "workspace round-trips the $vendoWorkspaceBytes envelope untouched", red: /binary envelope did not round-trip/ },
  { flaw: "readOfNoPathsRefuses", case: "workspace.read of no paths is an empty answer, not a refusal", red: /workspace\.read needs at least one path/ },
  { flaw: "emptyCommitIsAccepted", case: "workspace.commit refuses the same path twice in one commit, and an empty commit", red: /committing no entries at all did not throw/ },
  { flaw: "indexDefaultsElsewhere", case: "the workspace's default owner is one drawer on every verb", red: /an index with no owner did not see a commit with no owner/ },
];

const caseNamed = (name: string, options: Parameters<typeof storeOpsConformance>[0]) => {
  const found = storeOpsConformance(options).cases.find((one) => one.name === name);
  if (found === undefined) throw new Error(`no conformance case named ${JSON.stringify(name)}`);
  return found;
};

describe("every hardened StoreOps case fails against the mistake it names", () => {
  it("names a distinct flaw per proof, and a case that exists for each", () => {
    expect(new Set(proofs.map((proof) => proof.flaw)).size).toBe(proofs.length);
    // A case may be guarded by more than one flaw (the refusals case carries
    // two independent refusals), but every named case has to exist.
    const suite = storeOpsConformance({ makeOps: async () => ({ ops: memoryStoreOps() }) });
    const names = new Set(suite.cases.map((one) => one.name));
    for (const proof of proofs) expect(names).toContain(proof.case);
  });

  for (const proof of proofs) {
    it(`catches ${proof.flaw}`, async () => {
      const one = caseNamed(proof.case, { makeOps: async () => ({ ops: broken(proof.flaw) }) });
      await expect(one.run()).rejects.toThrow(proof.red);
    });
  }
});

describe("the tenancy case", () => {
  const NAME = "a neighbouring tenant shares no drawer with this one";

  it("passes for two tenants that share nothing", async () => {
    const one = caseNamed(NAME, {
      makeOps: async () => ({ ops: memoryStoreOps() }),
      makeNeighbour: async () => ({ ops: memoryStoreOps() }),
    });
    await expect(one.run()).resolves.toBeUndefined();
  });

  it("catches a neighbour that is really the same drawer", async () => {
    const one = caseNamed(NAME, {
      makeOps: async () => ({ ops: memoryStoreOps() }),
      // The "neighbour" is this tenant's own handle — the shape a mount that
      // forgot its tenant predicate presents.
      makeNeighbour: async (ops) => ({ ops }),
    });
    await expect(one.run()).rejects.toThrow(/crossed the tenant line/);
  });

  it("reports an omission, not a pass, when the mount hands out no neighbour", async () => {
    const one = caseNamed(NAME, { makeOps: async () => ({ ops: memoryStoreOps() }) });
    await expect(one.run()).resolves.toEqual({ omitted: expect.stringContaining("one tenant") });
  });

  it("catches a neighbour whose erase reaches across", async () => {
    // Separate drawers for everything the reads touch, ONE shared thread store:
    // a leak that only the destructive verb opens, which the read assertions
    // above would never see.
    const mine = memoryStoreOps();
    const theirs = memoryStoreOps();
    const shared: StoreOps = {
      ...theirs,
      transcripts: mine.transcripts,
      appData: mine.appData as StoreOps["appData"],
    };
    const one = caseNamed(NAME, {
      makeOps: async () => ({ ops: mine }),
      makeNeighbour: async () => ({ ops: shared }),
    });
    await expect(one.run()).rejects.toThrow(/tenant line|neighbour's/);
  });
});

describe("the omission bucket is a bucket, not a pass", () => {
  it("a case over an absent optional family answers omitted", async () => {
    const ops = memoryStoreOps();
    const one = caseNamed("transcripts.appendMessages lands a batch under the named subject", {
      makeOps: async () => ({ ops: { ...ops, transcripts: { ...ops.transcripts, appendMessages: undefined } } }),
    });
    await expect(one.run()).resolves.toEqual({ omitted: expect.stringContaining("omits transcripts.appendMessages") });
  });

  it("and answers nothing at all when the family is served", async () => {
    const one = caseNamed("transcripts.appendMessages lands a batch under the named subject", {
      makeOps: async () => ({ ops: memoryStoreOps() }),
    });
    await expect(one.run()).resolves.toBeUndefined();
  });

  /** The appData family reads the same way: a mount that omits it reports every
      case over it as omitted, rather than crashing on the first verb. */
  it("a case over an absent appData family answers omitted, not a TypeError", async () => {
    const one = caseNamed("appData.put stamps the target owner as refs.subject", {
      makeOps: async () => ({ ops: { ...memoryStoreOps(), appData: undefined } }),
    });
    await expect(one.run()).resolves.toEqual({ omitted: expect.stringContaining("omits the appData family") });
  });
});

/** Not a mutation proof — a guard on the reference itself. `memoryStoreOps` is
    what every one of the proofs above starts from, so a reference that quietly
    stopped serving something would make a whole column of them vacuous. */
describe("the memory reference serves what the proofs assume", () => {
  it("serves the batch append and reports the level that says so", async () => {
    const ops = memoryStoreOps();
    expect(ops.transcripts.appendMessages).toBeTypeOf("function");
    expect((await ops.status()).ops).toBeGreaterThanOrEqual(36);
  });

  /** A quarantined row is still its owner's data. The local backend matches the
      subject and app id it copies onto every lifted row (`store/src/erase.ts`),
      so the reference has to as well — otherwise a retention lift is a way for
      data to outlive an erasure, and the reference would disagree with the one
      shipped engine on the one cascade nobody gets to re-run.
      Read through `purge`, because that is the only door onto the quarantine:
      a purge that finds nothing left to destroy is the erase having reached it. */
  it("sweeps quarantined rows on both legs of the erase cascade", async () => {
    const far = () => new Date(Date.now() + 86_400_000).toISOString() as IsoDateTime;
    const lift = async (ops: StoreOps, collection: string): Promise<void> => {
      const swept = await ops.retention!.quarantine(collection, far());
      expect(swept.moved).toBe(1);
    };

    const bySubject = memoryStoreOps();
    await bySubject.engine.put("vendo_parked_call", { id: "p1", data: {}, refs: { subject: "erase_me" } });
    await bySubject.engine.put("vendo_parked_call", { id: "p2", data: {}, refs: { subject: "other" } });
    expect((await bySubject.retention!.quarantine("vendo_parked_call", far())).moved).toBe(2);
    await bySubject.lifecycle.erase({ subject: "erase_me" });
    // One of the two lifted rows was this subject's, so only the neighbour's is
    // left for the purge to destroy.
    expect((await bySubject.retention!.purge("vendo_parked_call", far())).purged).toBe(1);

    const byApp = memoryStoreOps();
    const history = engineAppHistory("app_lifted");
    await byApp.engine.put(history, { id: "v1", data: { version: 1 } });
    await lift(byApp, history);
    await byApp.lifecycle.erase({ appId: "app_lifted" });
    expect((await byApp.retention!.purge(history, far())).purged).toBe(0);
  });

  it("cascades an app-scoped erase past harness state", async () => {
    const ops = memoryStoreOps();
    await ops.engine.put("vendo_apps", {
      id: "app_x",
      data: { subject: "u", enabled: true, doc: { format: "vendo/app@1", id: "app_x", name: "x" } },
      refs: { subject: "u" },
    });
    const target = { appId: "app_x", collection: "notes", owner: "u" };
    const row: VendoRecord = await ops.appData.put(target, { id: "r", data: {} });
    expect(row.id).toBe("r");
    await ops.lifecycle.erase({ appId: "app_x" });
    expect(await ops.appData.get(target, "r")).toBeNull();
    expect(await ops.engine.get("vendo_apps", "app_x")).toBeNull();
  });
});

/**
 * SEAM: the turn takes its dropped files home.
 *
 * The REAL `POST /files` door writes, the REAL turn re-homes, and every read-back
 * is a FRESH workspace open — no stub on either side, so the producer (the upload
 * door) and the consumer (the turn) cannot agree with each other while both being
 * wrong about where a conversation's bytes live.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genericJwtPreset } from "@vendoai/actions/presets";
import { UPLOAD_HEADER, type FilesAdapter, type PermissionGrant, type Principal } from "@vendoai/core";
import { THREAD_ID_HEADER } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { jwt } from "../src/auth-presets/jwt.js";
import { createVendo, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SECRET = "vendo-rehome-uploads-seam-secret-with-entropy";
const SUBJECT = "host_sam";
const principal: Principal = { kind: "user", subject: SUBJECT };

/** Records every prompt it is asked to think with, then says one line. */
function recordingModel(seen: string[]): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "probe",
    modelId: "probe-v1",
    supportedUrls: {},
    async doStream(call: { prompt: unknown }) {
      seen.push(JSON.stringify(call.prompt));
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
            controller.enqueue({ type: "text-end", id: "t1" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
}

const grant: PermissionGrant = {
  id: "grt_rehome_uploads_seam",
  subject: SUBJECT,
  tool: "host_profile",
  descriptorHash: "sha256:rehome-uploads-seam",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-08-18T00:00:00.000Z",
};

/** Mint a REAL host bearer the way the actions half does. */
async function bearer(): Promise<Record<string, string>> {
  const mint = genericJwtPreset({ secret: SECRET });
  return (await mint(principal, grant))!.headers;
}

async function compose(files?: FilesAdapter): Promise<{ vendo: Vendo; seen: string[]; store: VendoStore }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-rehome-uploads-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const seen: string[] = [];
  const vendo = createVendo({
    models: { default: recordingModel(seen) },
    auth: jwt({ secret: SECRET }),
    store,
    ...(files === undefined ? {} : { files }),
  });
  return { vendo, seen, store };
}

const upload = (
  vendo: Vendo,
  name: string,
  body: Uint8Array,
  headers: Record<string, string>,
  contentType = "text/csv",
): Promise<Response> =>
  vendo.handler(new Request(`https://host.test/api/vendo/files?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": contentType, [UPLOAD_HEADER]: "1", ...headers },
    body: body as BodyInit,
  }));

/** The REAL read path, through a workspace opened AFTER the write. */
const readBack = async (vendo: Vendo, path: string): Promise<string> =>
  await (await vendo.harness.workspace(principal)).readFile(path);

const post = (vendo: Vendo, body: unknown, headers: Record<string, string>): Promise<Response> =>
  vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A host's own bucket, in memory — a REAL FilesAdapter, so what the bucket
    still holds is observed rather than assumed. */
function bucket(): FilesAdapter & { keys: () => string[] } {
  const blobs = new Map<string, Uint8Array>();
  return {
    put: async (key, value) => void blobs.set(key, value),
    get: async (key) => {
      const value = blobs.get(key);
      return value === undefined ? undefined : { bytes: value };
    },
    delete: async (key) => void blobs.delete(key),
    keys: () => [...blobs.keys()],
  };
}

describe("a turn takes its files home", () => {
  it("moves a staged drop under the thread and rewrites the part BEFORE it is stored", async () => {
    const { vendo } = await compose();
    const headers = await bearer();
    const { path: staged } = await (await upload(vendo, "ledger.csv", bytes("jan,31000\n"), headers)).json() as { path: string };

    const message = {
      id: "m1",
      role: "user",
      parts: [
        { type: "text", text: "what is in this?" },
        { type: "file", mediaType: "text/csv", filename: "ledger.csv", url: staged },
      ],
    };
    const response = await post(vendo, { threadId: "thr_home_1", message }, headers);
    await response.text();

    const homed = "/user/threads/thr_home_1/files/ledger.csv";
    expect(await readBack(vendo, homed)).toBe("jan,31000\n");
    // The staging copy is GONE — a move, not a copy.
    await expect(readBack(vendo, staged)).rejects.toThrow();

    // And the STORED transcript names the new home, not the staging path: the
    // pill a person clicks tomorrow has to point somewhere that still exists.
    const thread = await (await vendo.handler(new Request(
      "https://host.test/api/vendo/threads/thr_home_1",
      { headers },
    ))).json() as { messages: Array<{ parts: Array<{ type: string; url?: string }> }> };
    const stored = thread.messages[0]!.parts.find((part) => part.type === "file");
    expect(stored?.url).toBe(homed);
  });

  it("keeps both drops when ONE message carries two files of the same name", async () => {
    // The staging door mints a unique prefix per drop, so two `report.csv`s
    // survive as two rows — but the home address was derived from the NAME
    // alone, so the second move landed on the first and both pills then pointed
    // at one file. Silent: a workspace move overwrites without complaint, and
    // the loser's blob was released by the staging erase in the same turn.
    const { vendo } = await compose();
    const headers = await bearer();
    const first = await (await upload(vendo, "report.csv", bytes("first\n"), headers)).json() as { path: string };
    const second = await (await upload(vendo, "report.csv", bytes("second\n"), headers)).json() as { path: string };
    expect(first.path).not.toBe(second.path);

    const message = {
      id: "m1",
      role: "user",
      parts: [
        { type: "text", text: "compare these" },
        { type: "file", mediaType: "text/csv", filename: "report.csv", url: first.path },
        { type: "file", mediaType: "text/csv", filename: "report.csv", url: second.path },
      ],
    };
    await (await post(vendo, { threadId: "thr_twins", message }, headers)).text();

    const thread = await (await vendo.handler(new Request(
      "https://host.test/api/vendo/threads/thr_twins",
      { headers },
    ))).json() as { messages: Array<{ parts: Array<{ type: string; url?: string }> }> };
    const stored = thread.messages[0]!.parts.filter((part) => part.type === "file");
    expect(stored).toHaveLength(2);
    expect(stored[0]!.url).not.toBe(stored[1]!.url);
    // Each pill still opens the bytes the person actually sent.
    expect(await readBack(vendo, stored[0]!.url!)).toBe("first\n");
    expect(await readBack(vendo, stored[1]!.url!)).toBe("second\n");
  });

  it("keeps both drops when the shared name is as long as the door allows", async () => {
    // The unique fallback re-uses the STAGING leaf, which is the name plus a
    // nine-character prefix — so a name near the 200-character door limit built
    // a leaf past it, and `threadFilePath` refused the whole turn rather than
    // homing the second drop.
    const { vendo } = await compose();
    const headers = await bearer();
    const name = `${"ledger-".repeat(27)}rows.csv`;
    expect(name).toHaveLength(197);
    const first = await (await upload(vendo, name, bytes("first\n"), headers)).json() as { path: string };
    const second = await (await upload(vendo, name, bytes("second\n"), headers)).json() as { path: string };

    const message = {
      id: "m1",
      role: "user",
      parts: [
        { type: "file", mediaType: "text/csv", filename: name, url: first.path },
        { type: "file", mediaType: "text/csv", filename: name, url: second.path },
      ],
    };
    const response = await post(vendo, { threadId: "thr_long", message }, headers);
    await response.text();
    expect(response.status).toBe(200);

    const thread = await (await vendo.handler(new Request(
      "https://host.test/api/vendo/threads/thr_long",
      { headers },
    ))).json() as { messages: Array<{ parts: Array<{ type: string; url?: string }> }> };
    const stored = thread.messages[0]!.parts.filter((part) => part.type === "file");
    expect(stored).toHaveLength(2);
    expect(stored[0]!.url).not.toBe(stored[1]!.url);
    expect(await readBack(vendo, stored[0]!.url!)).toBe("first\n");
    expect(await readBack(vendo, stored[1]!.url!)).toBe("second\n");
  });

  it("keeps both drops when TWO TURNS of one thread carry the same name", async () => {
    // The same root cause one axis over: the within-message fix compared the
    // addresses THIS message was taking, which is empty on a later turn, so
    // turn 5's `report.csv` landed on turn 1's — and the staging erase then
    // released the first's blob. Silent user data loss, in a thread a person
    // keeps coming back to.
    const { vendo } = await compose();
    const headers = await bearer();

    const fileMessage = (id: string, url: string) => ({
      id,
      role: "user",
      parts: [{ type: "file", mediaType: "text/csv", filename: "report.csv", url }],
    });

    const first = await (await upload(vendo, "report.csv", bytes("january\n"), headers)).json() as { path: string };
    await (await post(vendo, { threadId: "thr_return", message: fileMessage("m1", first.path) }, headers)).text();

    const second = await (await upload(vendo, "report.csv", bytes("february\n"), headers)).json() as { path: string };
    await (await post(vendo, { threadId: "thr_return", message: fileMessage("m2", second.path) }, headers)).text();

    const thread = await (await vendo.handler(new Request(
      "https://host.test/api/vendo/threads/thr_return",
      { headers },
    ))).json() as { messages: Array<{ id: string; parts: Array<{ type: string; url?: string }> }> };
    const pills = thread.messages
      .flatMap((message) => message.parts.filter((part) => part.type === "file"));

    expect(pills).toHaveLength(2);
    expect(pills[0]!.url).not.toBe(pills[1]!.url);
    // Each turn's pill opens the bytes THAT turn carried.
    expect(await readBack(vendo, pills[0]!.url!)).toBe("january\n");
    expect(await readBack(vendo, pills[1]!.url!)).toBe("february\n");
  });

  it("homes a FIRST turn's drop under the id the server minted", async () => {
    const { vendo } = await compose();
    const headers = await bearer();
    const { path: staged } = await (await upload(vendo, "notes.txt", bytes("hello"), headers)).json() as { path: string };

    const response = await post(vendo, {
      message: {
        id: "m1",
        role: "user",
        parts: [{ type: "file", mediaType: "text/plain", filename: "notes.txt", url: staged }],
      },
    }, headers);
    const threadId = response.headers.get(THREAD_ID_HEADER)!;
    await response.text();

    expect(threadId).toMatch(/^thr_/);
    expect(await readBack(vendo, `/user/threads/${threadId}/files/notes.txt`)).toBe("hello");
  });

  it("leaves a shelf reference exactly where it is", async () => {
    const { vendo } = await compose();
    const headers = await bearer();
    await vendo.putUserFile({ principal, name: "kept.csv", content: "jan,31000\n" });

    await (await post(vendo, {
      threadId: "thr_home_2",
      message: {
        id: "m1",
        role: "user",
        parts: [{ type: "file", mediaType: "text/csv", filename: "kept.csv", url: "/user/files/kept.csv" }],
      },
    }, headers)).text();

    expect(await readBack(vendo, "/user/files/kept.csv")).toBe("jan,31000\n");
  });
});

describe("staging does not accumulate", () => {
  it("sweeps a stale stray the user never sent, and spares a fresh one", async () => {
    const { vendo, store } = await compose();
    const headers = await bearer();
    const { path: stale } = await (await upload(vendo, "abandoned.csv", bytes("x"), headers)).json() as { path: string };
    // Age it past the window in the REAL row the sweep's `stat` reads. It cannot
    // be done through `utimes`: the façade stages an mtime, and `commit` writes
    // `updated_at = now` over it (store/workspace-rows.ts), so a staged mtime
    // never survives the commit. Nothing else here is reached around.
    await (store.raw() as { query: (q: string, p: unknown[]) => Promise<unknown> })
      .query("UPDATE vendo_workspace_files SET updated_at = $2 WHERE path = $1", [
        stale,
        new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
      ]);
    const { path: fresh } = await (await upload(vendo, "pending.csv", bytes("y"), headers)).json() as { path: string };

    await (await post(vendo, {
      threadId: "thr_sweep",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
    }, headers)).text();

    await expect(readBack(vendo, stale)).rejects.toThrow();
    expect(await readBack(vendo, fresh)).toBe("y");
  });

  it("sweeps a nested stray the agent's own shell left behind", async () => {
    // The upload door cannot make one — `leafName` refuses a separator. The
    // SHELL can: this build mounts the whole workspace under the agent's bash,
    // so `cp -r` into `/user/uploads/…` plants a subtree. A directory's `stat`
    // answers the epoch, so it is never spared by the six-hour rule, and the
    // sweep's non-recursive `rm` then threw ENOTEMPTY on EVERY later turn —
    // before the model ran, so the whole thread 500'd for good.
    const { vendo } = await compose();
    const headers = await bearer();
    const shell = await vendo.harness.workspace(principal);
    await shell.writeFile("/user/uploads/scratch/notes.txt", "left behind");
    await shell.commit();

    const response = await post(vendo, {
      threadId: "thr_nested_stray",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
    }, headers);
    await response.text();

    expect(response.status).toBe(200);
    await expect(readBack(vendo, "/user/uploads/scratch/notes.txt")).rejects.toThrow();
  });

  // The sweep removed the ROW and kept the OBJECT: `workspace.rm` tombstones,
  // so the row moved to history with its `blob_ref` intact, under an address no
  // erase axis reaches. An upload nobody ever sent leaked its bytes forever.
  it("frees the stale stray's object, not just its row", async () => {
    const files = bucket();
    const { vendo, store } = await compose(files);
    const headers = await bearer();
    // Past the inline cap, so the content is a real object in the host's bucket.
    const big = new Uint8Array(200_000).fill(65);
    const { path: stale } = await (await upload(vendo, "abandoned.pdf", big, headers, "application/pdf"))
      .json() as { path: string };
    expect(files.keys()).toHaveLength(1);

    await (store.raw() as { query: (q: string, p: unknown[]) => Promise<unknown> })
      .query("UPDATE vendo_workspace_files SET updated_at = $2 WHERE path = $1", [
        stale,
        new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
      ]);

    await (await post(vendo, {
      threadId: "thr_sweep_object",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
    }, headers)).text();

    await expect(readBack(vendo, stale)).rejects.toThrow();
    expect(files.keys()).toHaveLength(0);
  });
});

describe("what the model is handed", () => {
  it("names a thread file and a shelf file alike, and still sends images inline", async () => {
    const { vendo, seen } = await compose();
    const headers = await bearer();
    const { path: staged } = await (await upload(vendo, "ledger.csv", bytes("jan,31000\n"), headers)).json() as { path: string };

    await (await post(vendo, {
      threadId: "thr_refs",
      message: {
        id: "m1",
        role: "user",
        parts: [
          { type: "text", text: "chart this" },
          { type: "file", mediaType: "text/csv", filename: "ledger.csv", url: staged },
          { type: "file", mediaType: "image/png", filename: "chart.png", url: "data:image/png;base64,aGVsbG8=" },
        ],
      },
    }, headers)).text();

    const prompt = seen[0]!;
    expect(prompt).toContain("The user shared ledger.csv, saved at /user/threads/thr_refs/files/ledger.csv");
    expect(prompt).not.toContain("text/csv");
    expect(prompt).toContain("aGVsbG8=");
  });
});

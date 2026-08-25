/**
 * SEAM: a user's file drawer, written through the REAL doors and read back
 * through the REAL workspace store. No mock on either side — the upload door
 * and `putUserFile` share one server-side write, and every read-back here is a
 * FRESH `workspace()` open (its own path index), so nothing is proved by a
 * value the write happened to leave in memory.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genericJwtPreset } from "@vendoai/actions/presets";
import { UPLOAD_HEADER, type FilesAdapter, type PermissionGrant, type Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { jwt } from "../src/auth-presets/jwt.js";
import { createVendo, type Vendo } from "../src/server.js";
import { UPLOAD_MAX_BYTES } from "../src/wire/files.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SECRET = "vendo-user-files-seam-secret-with-entropy";
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
  id: "grt_user_files_seam",
  subject: SUBJECT,
  tool: "host_profile",
  descriptorHash: "sha256:user-files-seam",
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

/** A host's own bucket, in memory — a REAL `FilesAdapter`, which is the only
    way to raise the drawer past the store's own blob cap. */
function bucket(): FilesAdapter {
  const blobs = new Map<string, Uint8Array>();
  return {
    put: async (key, value) => void blobs.set(key, value),
    get: async (key) => {
      const value = blobs.get(key);
      return value === undefined ? undefined : { bytes: value };
    },
    delete: async (key) => void blobs.delete(key),
  };
}

async function compose(files?: FilesAdapter): Promise<{ vendo: Vendo; seen: string[] }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-user-files-"));
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
  return { vendo, seen };
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

describe("the user's file drawer — real doors, real workspace", () => {
  it("saves an UPLOAD where a LATER workspace open finds it", async () => {
    // Through the door, not `putUserFile`: this build moved a drop's landing
    // address to staging, and retargeting this test at the trusted server call
    // would have left the default `text/csv` upload path — the one a browser
    // actually takes — with no happy-path coverage at all.
    const { vendo } = await compose();
    const response = await upload(vendo, "ledger.csv", bytes("month,revenue\njan,31000\n"), await bearer());

    expect(response.status).toBe(200);
    const staged = await response.json() as { path: string; bytes: number };
    expect(staged).toEqual({
      path: expect.stringMatching(/^\/user\/uploads\/[0-9a-f]{8}-ledger\.csv$/),
      bytes: 24,
    });
    // A workspace opened fresh — its own index read — sees the same bytes.
    expect(await readBack(vendo, staged.path)).toBe("month,revenue\njan,31000\n");
  });

  it("puts a host-pushed file through the SAME write, read back the same way", async () => {
    const { vendo } = await compose();
    const put = await vendo.putUserFile({ principal, name: "statement.txt", content: "opening balance 100" });

    expect(put).toEqual({ path: "/user/files/statement.txt", bytes: 19 });
    expect(await readBack(vendo, "/user/files/statement.txt")).toBe("opening balance 100");
  });

  it("is not bound by the DOOR's cap when the caller is the host", async () => {
    // The bound on a trusted write is the `files:` adapter, so this is the
    // deployment that wired one. Without it the store's own blob cap applies
    // and refuses by naming `files:` — which is the honest answer, not this
    // door's cap leaking onto the SDK.
    const { vendo } = await compose(bucket());
    const big = new Uint8Array(UPLOAD_MAX_BYTES + 1024).fill(65);

    // The same payload the door refuses below lands through the trusted door.
    const put = await vendo.putUserFile({ principal, name: "export.bin", content: big });
    expect(put.bytes).toBe(big.byteLength);
    expect((await readBack(vendo, "/user/files/export.bin")).length).toBe(big.byteLength);
  });

  it("refuses an otherwise valid upload that carries no upload header", async () => {
    const { vendo } = await compose();
    // Everything else is right: signed-in caller, good name, tiny body, and a
    // CORS-SAFELISTED media type — the exact shape a hostile page could post
    // cross-origin with the user's ambient cookie. The header is the only thing
    // a browser cannot forge without a preflight, so it is the only thing
    // standing between that page and the user's drawer.
    const response = await vendo.handler(new Request("https://host.test/api/vendo/files?name=evil.txt", {
      method: "POST",
      headers: { "content-type": "text/plain", ...(await bearer()) },
      body: bytes("owned") as BodyInit,
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    await expect(readBack(vendo, "/user/files/evil.txt")).rejects.toThrow();
  });

  it("takes a text/plain upload that DOES carry the header", async () => {
    const { vendo } = await compose();
    // The same safelisted media type, now same-origin: the toll is the header,
    // never the content type, so ordinary .txt uploads still work.
    const response = await upload(vendo, "notes.txt", bytes("hello"), await bearer(), "text/plain");

    expect(response.status).toBe(200);
    const { path } = await response.json() as { path: string };
    expect(path).toMatch(/^\/user\/uploads\/[0-9a-f]{8}-notes\.txt$/);
    expect(await readBack(vendo, path)).toBe("hello");
  });

  it("refuses an over-cap upload on its DECLARED length, before reading it", async () => {
    const { vendo } = await compose();
    // No body at all — only the header claiming one. A door that measured after
    // buffering could not answer this at all; this one refuses on the claim.
    const response = await vendo.handler(new Request("https://host.test/api/vendo/files?name=huge.csv", {
      method: "POST",
      headers: {
        "content-type": "text/csv",
        "content-length": String(UPLOAD_MAX_BYTES + 1),
        [UPLOAD_HEADER]: "1",
        ...(await bearer()),
      },
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain(String(UPLOAD_MAX_BYTES + 1));
  });

  it("refuses an over-cap upload with 400, and writes nothing", async () => {
    const { vendo } = await compose();
    const response = await upload(vendo, "huge.csv", new Uint8Array(UPLOAD_MAX_BYTES + 1), await bearer());

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    await expect(readBack(vendo, "/user/files/huge.csv")).rejects.toThrow();
  });

  it("refuses a name that is a path with 400", async () => {
    const { vendo } = await compose();
    const headers = await bearer();

    for (const name of ["../escape.csv", "nested/ledger.csv", ".."]) {
      const response = await upload(vendo, name, bytes("x"), headers);
      expect(response.status, name).toBe(400);
      expect((await response.json()).error.code, name).toBe("validation");
    }
  });

  it("REPLACES the file when the same name arrives again", async () => {
    const { vendo } = await compose();

    await vendo.putUserFile({ principal, name: "ledger.csv", content: "jan,31000\n" });
    const second = await vendo.putUserFile({ principal, name: "ledger.csv", content: "jan,33000\nfeb,39000\n" });

    expect(second).toEqual({ path: "/user/files/ledger.csv", bytes: 20 });
    expect(await readBack(vendo, "/user/files/ledger.csv")).toBe("jan,33000\nfeb,39000\n");
  });

  it("sends an image INLINE and a saved file as a reference", async () => {
    const { vendo, seen } = await compose();
    const headers = await bearer();
    await upload(vendo, "ledger.csv", bytes("jan,31000\n"), headers);

    const message: UIMessage = {
      id: "m1",
      role: "user",
      parts: [
        { type: "text", text: "make me a dashboard of this" },
        // What the composer sends for a saved file: the reference, not bytes.
        { type: "file", mediaType: "text/csv", filename: "ledger.csv", url: "/user/files/ledger.csv" },
        // And what it still sends for an image, so vision keeps working.
        { type: "file", mediaType: "image/png", filename: "chart.png", url: "data:image/png;base64,aGVsbG8=" },
      ],
    } as UIMessage;
    await (await post(vendo, { threadId: "thr_files_1", message }, headers)).text();

    const prompt = seen[0]!;
    // The saved file reaches the model as a line of text naming where it is…
    expect(prompt).toContain("The user shared ledger.csv, saved at /user/files/ledger.csv");
    // …and never as file content the provider would read as base64.
    expect(prompt).not.toContain("text/csv");
    // The image is untouched: still a file part, still carrying its own bytes.
    expect(prompt).toContain("image/png");
    expect(prompt).toContain("aGVsbG8=");
  });
});

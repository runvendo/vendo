/**
 * SEAM: `createVendo({ uploadMaxBytes })` → the composition → the REAL drop
 * door. Nothing is stubbed between the config key and the refusal: every case
 * builds a real `createVendo` over a real store and posts a real Request, and
 * the accepted ones are read back through a FRESH workspace open.
 *
 * The refusal COPY is pinned verbatim, both halves of it. Raising the door is
 * only half a fix — past 5 MiB with no `files:` adapter the upload clears this
 * door and dies at the store's own blob cap — so the message names the knob
 * AND the backing the bytes would have landed in, and which backing that is
 * depends on what the host wired.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genericJwtPreset } from "@vendoai/actions/presets";
import { UPLOAD_HEADER, type FilesAdapter, type PermissionGrant, type Principal } from "@vendoai/core";
import { createStore, FILES_STORE_MAX_BYTES, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { jwt } from "../src/auth-presets/jwt.js";
import { createVendo, type Vendo } from "../src/server.js";
import { UPLOAD_MAX_BYTES } from "../src/wire/files.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SECRET = "vendo-upload-cap-seam-secret-with-entropy";
const SUBJECT = "host_sam";
const principal: Principal = { kind: "user", subject: SUBJECT };

const stubModel = {
  specificationVersion: "v2",
  provider: "probe",
  modelId: "probe-v1",
  supportedUrls: {},
} as unknown as LanguageModel;

const grant: PermissionGrant = {
  id: "grt_upload_cap_seam",
  subject: SUBJECT,
  tool: "host_profile",
  descriptorHash: "sha256:upload-cap-seam",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-08-18T00:00:00.000Z",
};

/** A REAL host bearer, minted the way the actions half does. */
async function bearer(): Promise<Record<string, string>> {
  const mint = genericJwtPreset({ secret: SECRET });
  return (await mint(principal, grant))!.headers;
}

/** A host's own bucket, in memory — a REAL `FilesAdapter`, which is what makes
    the venue "byo" and the only way to hold a file past the store's blob cap. */
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

async function compose(config: { uploadMaxBytes?: number; files?: FilesAdapter }): Promise<Vendo> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-upload-cap-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return createVendo({
    models: { default: stubModel },
    auth: jwt({ secret: SECRET }),
    store,
    ...config,
  });
}

const upload = (vendo: Vendo, name: string, body: Uint8Array, headers: Record<string, string>): Promise<Response> =>
  vendo.handler(new Request(`https://host.test/api/vendo/files?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "text/csv", [UPLOAD_HEADER]: "1", ...headers },
    body: body as BodyInit,
  }));

const messageOf = async (response: Response): Promise<string> => (await response.json()).error.message;

/** The REAL read path, through a workspace opened AFTER the write. */
const readBack = async (vendo: Vendo, path: string): Promise<string> =>
  await (await vendo.harness.workspace(principal)).readFile(path);

describe("createVendo({ uploadMaxBytes }) — the drop door's cap, moved", () => {
  it("defaults to UPLOAD_MAX_BYTES when the key is unset", async () => {
    const vendo = await compose({});
    const response = await upload(vendo, "huge.csv", new Uint8Array(UPLOAD_MAX_BYTES + 1), await bearer());

    expect(response.status).toBe(400);
    expect(await messageOf(response)).toContain(`allows at most ${UPLOAD_MAX_BYTES}`);
  });

  it("REFUSES below the default when the host lowers it", async () => {
    const vendo = await compose({ uploadMaxBytes: 32 });
    // Comfortably under the 5 MiB default: only the knob can be refusing this.
    const response = await upload(vendo, "small.csv", new Uint8Array(64), await bearer());

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation");
    await expect(readBack(vendo, "/user/files/small.csv")).rejects.toThrow();
  });

  it("ACCEPTS above the default when the host raises it, and the bytes land", async () => {
    // The other direction, which no default can fake: a body the shipped cap
    // would have refused goes through, into the adapter that can hold it.
    const vendo = await compose({ uploadMaxBytes: UPLOAD_MAX_BYTES * 2, files: bucket() });
    const big = new Uint8Array(UPLOAD_MAX_BYTES + 1024).fill(65);
    const response = await upload(vendo, "export.bin", big, await bearer());

    expect(response.status).toBe(200);
    // A drop STAGES; the cap is what this test is about, so the assertion is the
    // byte count and that every one of them landed where the door said.
    const staged = await response.json() as { path: string; bytes: number };
    expect(staged).toEqual({
      path: expect.stringMatching(/^\/user\/uploads\/[0-9a-f]{8}-export\.bin$/),
      bytes: big.byteLength,
    });
    expect((await readBack(vendo, staged.path)).length).toBe(big.byteLength);
  });

  it("refuses on the DECLARED length too, with the same copy", async () => {
    const vendo = await compose({ uploadMaxBytes: 32 });
    // No body at all — only the header claiming one. The pre-read refusal is a
    // second call site, so it gets the same message or it is a second copy.
    const response = await vendo.handler(new Request("https://host.test/api/vendo/files?name=claimed.csv", {
      method: "POST",
      headers: { "content-type": "text/csv", "content-length": "999", [UPLOAD_HEADER]: "1", ...(await bearer()) },
    }));

    expect(response.status).toBe(400);
    expect(await messageOf(response)).toBe(
      '"claimed.csv" is 999 bytes and the upload door allows at most 32: send a smaller file,'
      + " or raise createVendo({ uploadMaxBytes }). These bytes land in this deployment's store,"
      + ` which caps one file at ${FILES_STORE_MAX_BYTES} bytes — wire createVendo({ files }) with a`
      + " FilesAdapter (s3Files) before raising the door past it.",
    );
  });

  it('names the STORE backing, and the cap that really bounds it, with no files: wired', async () => {
    const vendo = await compose({ uploadMaxBytes: 32 });
    const response = await upload(vendo, "ledger.csv", new Uint8Array(64), await bearer());

    expect(await messageOf(response)).toBe(
      '"ledger.csv" is 64 bytes and the upload door allows at most 32: send a smaller file,'
      + " or raise createVendo({ uploadMaxBytes }). These bytes land in this deployment's store,"
      + ` which caps one file at ${FILES_STORE_MAX_BYTES} bytes — wire createVendo({ files }) with a`
      + " FilesAdapter (s3Files) before raising the door past it.",
    );
  });

  it("names the BYO adapter instead once files: is wired", async () => {
    const vendo = await compose({ uploadMaxBytes: 32, files: bucket() });
    const response = await upload(vendo, "ledger.csv", new Uint8Array(64), await bearer());

    const message = await messageOf(response);
    expect(message).toBe(
      '"ledger.csv" is 64 bytes and the upload door allows at most 32: send a smaller file,'
      + " or raise createVendo({ uploadMaxBytes }). These bytes land in"
      + " the FilesAdapter wired at createVendo({ files }).",
    );
    // The store's cap is not this deployment's bound, so it must not be quoted
    // at a host who already wired their way past it.
    expect(message).not.toContain(String(FILES_STORE_MAX_BYTES));
  });
});

/** `NaN` and `Infinity` are numbers, so the typed-config posture lets them
    through — and both make `bytes > cap` false forever, which does not move the
    door but DELETES it. Compose is the last moment anyone can be told, so each
    of these must refuse there rather than reach a door at all. */
describe("createVendo({ uploadMaxBytes }) — a cap that is not a byte count", () => {
  it.each([NaN, Infinity, -1, 0, 1.5])("refuses at compose time, naming the value:", async (uploadMaxBytes) => {
    await expect(compose({ uploadMaxBytes })).rejects.toThrow(
      `createVendo({ uploadMaxBytes }): must be a positive integer, got ${uploadMaxBytes}`,
    );
  });

  it("still composes on a real byte count", async () => {
    await expect(compose({ uploadMaxBytes: 32 })).resolves.toBeDefined();
  });
});

/**
 * SEAM: the drop door STAGES. Written through the REAL `POST /files` door and
 * read back through the REAL workspace store — no mock on either side, so the
 * door and the workspace cannot disagree about where a dropped file landed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genericJwtPreset } from "@vendoai/actions/presets";
import { UPLOAD_HEADER, type FilesAdapter, type PermissionGrant, type Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { jwt } from "../src/auth-presets/jwt.js";
import { createVendo, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SECRET = "vendo-upload-staging-seam-secret-with-entropy";
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
  id: "grt_upload_staging_seam",
  subject: SUBJECT,
  tool: "host_profile",
  descriptorHash: "sha256:upload-staging-seam",
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

async function compose(files?: FilesAdapter): Promise<{ vendo: Vendo; seen: string[] }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-upload-staging-"));
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

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("the drop door stages, it does not shelve", () => {
  it("lands a dropped file in staging, not in the user's shelf", async () => {
    const { vendo } = await compose();

    const response = await upload(vendo, "ledger.csv", bytes("month,revenue\njan,31000\n"), await bearer());

    const { path } = await response.json() as { path: string; bytes: number };
    expect(path).toMatch(/^\/user\/uploads\/[0-9a-f]{8}-ledger\.csv$/);
    expect(await readBack(vendo, path)).toBe("month,revenue\njan,31000\n");
    await expect(readBack(vendo, "/user/files/ledger.csv")).rejects.toThrow();
  });

  it("does not let two drops of one name overwrite each other", async () => {
    const { vendo } = await compose();
    const headers = await bearer();

    const first = await (await upload(vendo, "ledger.csv", bytes("jan,31000\n"), headers)).json() as { path: string };
    const second = await (await upload(vendo, "ledger.csv", bytes("feb,39000\n"), headers)).json() as { path: string };

    expect(first.path).not.toBe(second.path);
    expect(await readBack(vendo, first.path)).toBe("jan,31000\n");
    expect(await readBack(vendo, second.path)).toBe("feb,39000\n");
  });

  it("still refuses a name that is a path", async () => {
    const { vendo } = await compose();

    const response = await upload(vendo, "../escape.csv", bytes("x"), await bearer());

    expect(response.status).toBe(400);
  });

  it("leaves vendo.putUserFile on the SHELF — a host push is a deliberate save", async () => {
    const { vendo } = await compose();

    expect(await vendo.putUserFile({ principal, name: "statement.txt", content: "opening balance 100" }))
      .toEqual({ path: "/user/files/statement.txt", bytes: 19 });
  });
});

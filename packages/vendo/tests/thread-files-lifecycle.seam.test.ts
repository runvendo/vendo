/**
 * SEAM: a file's whole life, with no stub anywhere on it.
 *
 * A real `POST /files` upload → a real turn that re-homes it → a real `bash` call
 * that reads it at the new address → a real `DELETE /threads/:id` → the rows AND
 * the object in a real FilesAdapter, both checked afterwards. Each half is the
 * shipped one; a fixture that mocked either end could not catch them disagreeing
 * about where a conversation's bytes live.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genericJwtPreset } from "@vendoai/actions/presets";
import {
  UPLOAD_HEADER,
  VENDO_BASH_TOOL,
  type FilesAdapter,
  type PermissionGrant,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { jwt } from "../src/auth-presets/jwt.js";
import { createVendo, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SECRET = "vendo-thread-files-seam-secret-with-entropy";
const SUBJECT = "host_sam";
const principal: Principal = { kind: "user", subject: SUBJECT };

const grant: PermissionGrant = {
  id: "grt_thread_files_seam",
  subject: SUBJECT,
  tool: "host_profile",
  descriptorHash: "sha256:thread-files-seam",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-08-23T00:00:00.000Z",
};

async function bearer(): Promise<Record<string, string>> {
  return (await genericJwtPreset({ secret: SECRET })(principal, grant))!.headers;
}

/** A host's own bucket, in memory — a REAL FilesAdapter, so the blob half of the
    cascade is observed rather than assumed. */
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

/** Says one line and stops — the turn is the subject here, not the thinking. */
const quietModel = (): LanguageModel => ({
  specificationVersion: "v2",
  provider: "probe",
  modelId: "probe-v1",
  supportedUrls: {},
  async doStream() {
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
} as unknown as LanguageModel);

async function compose(): Promise<{ vendo: Vendo; files: ReturnType<typeof bucket> }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-thread-files-"));
  const store: VendoStore = createStore({ dataDir });
  const files = bucket();
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    vendo: createVendo({ store, files, auth: jwt({ secret: SECRET }), models: { default: quietModel() } }),
    files,
  };
}

describe("SEAM — a dropped file's whole life", () => {
  it("stages, homes, is readable by the shell, and is really gone when the thread is", async () => {
    const { vendo, files } = await compose();
    const headers = await bearer();

    // 1. It arrives, through the real door, and stages.
    const big = new Uint8Array(200_000).fill(65); // past the inline cap, so it becomes a BLOB
    const uploaded = await vendo.handler(new Request(
      "https://host.test/api/vendo/files?name=scan.pdf",
      { method: "POST", headers: { "content-type": "application/pdf", [UPLOAD_HEADER]: "1", ...headers }, body: big as BodyInit },
    ));
    const { path: staged } = await uploaded.json() as { path: string };
    expect(staged.startsWith("/user/uploads/")).toBe(true);
    expect(files.keys()).toHaveLength(1);

    // 2. The turn that receives it homes it.
    await (await vendo.handler(new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        threadId: "thr_life",
        message: {
          id: "m1",
          role: "user",
          parts: [
            { type: "text", text: "what is this?" },
            { type: "file", mediaType: "application/pdf", filename: "scan.pdf", url: staged },
          ],
        },
      }),
    }))).text();

    const homed = "/user/threads/thr_life/files/scan.pdf";
    const workspace = await vendo.harness.workspace(principal);
    expect(await workspace.exists(homed)).toBe(true);
    expect(await workspace.exists(staged)).toBe(false);

    // 3. The SHELL finds it there — the address the agent is told is the address
    //    that works.
    const ctx: RunContext = {
      principal,
      venue: "chat",
      presence: "present",
      sessionId: "s_life",
      // `trn_` + exactly 32 hex (ids.ts:69) — the guard writes a real audit row
      // for this call and `auditEventSchema` rejects anything else.
      turnId: `trn_${"0".repeat(28)}11fe`,
    };
    const outcome = await vendo.guardedTools.execute(
      { id: "call_1", tool: VENDO_BASH_TOOL, args: { command: `wc -c < ${homed}` } },
      ctx,
    );
    expect(outcome.status).toBe("ok");
    expect((outcome as { output: { stdout: string } }).output.stdout.trim()).toBe("200000");

    // 4. Deleting the conversation really deletes it — rows AND object.
    const deleted = await vendo.handler(new Request("https://host.test/api/vendo/threads/thr_life", {
      method: "DELETE",
      // The wire's CSRF floor requires the json content-type on every mutation
      // that is not the upload door itself (server.ts:237-248).
      headers: { "content-type": "application/json", ...headers },
    }));
    expect(deleted.status).toBe(200);

    const after = await vendo.harness.workspace(principal);
    expect(await after.exists(homed)).toBe(false);
    expect(files.keys()).toHaveLength(0);
  });
});

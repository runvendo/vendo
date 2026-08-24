/**
 * SEAM: deleting a conversation deletes it. The REAL `DELETE /threads/:id` door
 * runs against the REAL store, and the row counts are read straight out of the
 * database afterwards — no stub on either side, so the door and the store cannot
 * disagree about what "deleted" means.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genericJwtPreset } from "@vendoai/actions/presets";
import type { PermissionGrant, Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { jwt } from "../src/auth-presets/jwt.js";
import { createVendo, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SECRET = "vendo-thread-delete-seam-secret-with-entropy";
const SUBJECT = "host_sam";
const principal: Principal = { kind: "user", subject: SUBJECT };

/** Says one line and stops — the delete is the subject here, not the thinking. */
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

const grant: PermissionGrant = {
  id: "grt_thread_delete_seam",
  subject: SUBJECT,
  tool: "host_profile",
  descriptorHash: "sha256:thread-delete-seam",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-08-18T00:00:00.000Z",
};

async function bearer(): Promise<Record<string, string>> {
  return (await genericJwtPreset({ secret: SECRET })(principal, grant))!.headers;
}

async function compose(): Promise<{ vendo: Vendo; store: VendoStore }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-thread-delete-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const vendo = createVendo({
    models: { default: quietModel() },
    auth: jwt({ secret: SECRET }),
    store,
  });
  return { vendo, store };
}

const post = (vendo: Vendo, body: unknown, headers: Record<string, string>): Promise<Response> =>
  vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));

describe("deleting a conversation deletes it", () => {
  it("takes the messages and the harness state with the thread row", async () => {
    const { vendo, store } = await compose();
    const headers = await bearer();
    await (await post(vendo, {
      threadId: "thr_bye",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
    }, headers)).text();

    const rows = async (sql: string): Promise<number> =>
      Number((await (store.raw() as { query: (q: string, p: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> })
        .query(sql, ["thr_bye"])).rows.length);
    expect(await rows("SELECT id FROM vendo_thread_messages WHERE thread_id = $1")).toBeGreaterThan(0);

    const response = await vendo.handler(new Request("https://host.test/api/vendo/threads/thr_bye", {
      method: "DELETE",
      // The wire's CSRF floor requires it on every mutation (server.ts:237-248).
      headers: { "content-type": "application/json", ...headers },
    }));

    expect(response.status).toBe(200);
    expect(await rows("SELECT id FROM vendo_threads WHERE id = $1")).toBe(0);
    expect(await rows("SELECT id FROM vendo_thread_messages WHERE thread_id = $1")).toBe(0);
  });

  it("refuses to touch another subject's conversation", async () => {
    const { vendo, store } = await compose();
    await (await post(vendo, {
      threadId: "thr_mine",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
    }, await bearer())).text();

    // A DIFFERENT subject's bearer, same thread id.
    const other = genericJwtPreset({ secret: SECRET });
    const otherHeaders = (await other({ kind: "user", subject: "host_mallory" }, { ...grant, subject: "host_mallory" }))!.headers;
    await vendo.handler(new Request("https://host.test/api/vendo/threads/thr_mine", {
      method: "DELETE",
      headers: { "content-type": "application/json", ...otherHeaders },
    }));

    const kept = await (store.raw() as { query: (q: string, p: unknown[]) => Promise<{ rows: unknown[] }> })
      .query("SELECT id FROM vendo_threads WHERE id = $1", ["thr_mine"]);
    expect(kept.rows).toHaveLength(1);
  });
});

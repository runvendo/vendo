/**
 * Spec 2026-08-05 §1 — SEAM: the host's `facts` (auth preset user resolver)
 * through the REAL wire to the REAL prompt. Real jwt() preset → real
 * createContextResolver (inside the wire handler) → real assembleSystemPrompt.
 * No mock on either side; the model merely records what it was told.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genericJwtPreset } from "@vendoai/actions/presets";
import type { PermissionGrant } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { jwt } from "../src/auth-presets/jwt.js";
import { createVendo, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SECRET = "vendo-user-facts-seam-secret-with-entropy";

/** Records every system prompt it is asked to think with, then says one line. */
function recordingModel(seen: string[]): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "probe",
    modelId: "probe-v1",
    supportedUrls: {},
    async doStream(call: { prompt: Array<{ role: string; content: unknown }> }) {
      seen.push(
        call.prompt.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n"),
      );
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

const grantFor = (subject: string): PermissionGrant => ({
  id: "grt_user_facts_seam",
  subject,
  tool: "host_profile",
  descriptorHash: "sha256:user-facts-seam",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-08-05T00:00:00.000Z",
});

/** Mint a REAL host bearer the way the actions half does. */
async function bearer(subject: string): Promise<Record<string, string>> {
  const mint = genericJwtPreset({ secret: SECRET });
  const material = await mint({ kind: "user", subject }, grantFor(subject));
  return material!.headers;
}

async function compose(): Promise<{ vendo: Vendo; seen: string[] }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-user-facts-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const seen: string[] = [];
  const vendo = createVendo({
    model: recordingModel(seen),
    auth: jwt({
      secret: SECRET,
      // A user the host knows but asserts NO facts about — the surviving
      // "no [User] block" case now that a request with no identity at all is
      // refused outright.
      user: (subject) => subject === "host_mia"
        ? { display: "Mia Nakamura", email: "mia@host.test", facts: { name: "Mia Nakamura", plan: "Pro", accounts: 2 } }
        : { display: "Someone" },
    }),
    store,
  });
  return { vendo, seen };
}

const userMessage = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

const post = (vendo: Vendo, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));

describe("[User] facts — real preset through real wire into the real prompt", () => {
  it("renders the resolver's facts as the [User] block", async () => {
    const { vendo, seen } = await compose();
    const headers = await bearer("host_mia");
    await (await post(vendo, { threadId: "thr_facts_1", message: userMessage("m1", "hello") }, headers)).text();
    expect(seen[0]).toContain("[User]\nname: Mia Nakamura\nplan: Pro\naccounts: 2");
  });

  it("renders no [User] block when the seam asserts nothing about the user", async () => {
    const { vendo, seen } = await compose();
    const headers = await bearer("host_other");
    await (await post(vendo, { threadId: "thr_facts_2", message: userMessage("m2", "hello") }, headers)).text();
    expect(seen[0]).not.toContain("[User]");
  });
});

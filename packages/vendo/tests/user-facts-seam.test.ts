/**
 * Spec 2026-08-05 §1 — SEAM: the host's `facts` through the REAL wire to the
 * REAL prompt. Real preset (or real hand-written `auth` object) → real
 * createContextResolver (inside the wire handler) → real assembleSystemPrompt.
 * No mock on either side; the model merely records what it was told.
 *
 * Both spellings of the ONE DOOR are proven here against the same assertions,
 * because `auth` takes either and the whole claim of the redesign is that they
 * are the same value: `auth: jwt({ user })` and `auth: { principal, facts }`
 * must put the identical `[User]` block in front of the model. A suite that
 * covered only the preset would let the hand-written path — the one the docs
 * now lead with, and the one `vendo init --auth none` writes — rot silently.
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
import type { HostAuthPreset } from "../src/auth-presets/shared.js";
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

/** The one user this suite asserts facts about, and the block those facts must
    become. Shared by both spellings so the preset and the hand-written object
    are held to the SAME output rather than to two hand-copied expectations. */
const MIA = { name: "Mia Nakamura", plan: "Pro", accounts: 2 } as const;
const MIA_BLOCK = "[User]\nname: Mia Nakamura\nplan: Pro\naccounts: 2";

/** The ONE DOOR, in both spellings a host may write it.
 *
 *  `auth` and `headers` travel together because a hand-written door does not
 *  have to speak JWT at all — the point of the object form is that the host's
 *  OWN session lookup, whatever it reads, fills the same seams. So the preset
 *  arm is driven by a real minted bearer and the object arm by the plain header
 *  a host's session decode would stand in for; both end at the same prompt. */
interface Spelling {
  readonly label: string;
  readonly auth: HostAuthPreset;
  readonly headers: (subject: string) => Promise<Record<string, string>>;
}

/** A preset's result: `user` carries the facts, the preset builds the seams. */
const presetSpelling: Spelling = {
  label: "a preset — auth: jwt({ user })",
  auth: jwt({
    secret: SECRET,
    // A user the host knows but asserts NO facts about — the surviving
    // "no [User] block" case now that a request with no identity at all is
    // refused outright.
    user: (subject) => subject === "host_mia"
      ? { display: "Mia Nakamura", email: "mia@host.test", facts: { ...MIA } }
      : { display: "Someone" },
  }),
  headers: bearer,
};

/** An object the host wrote: no preset, no vendor, no JWT — a session header
 *  this deployment happens to trust, read twice through the same helper the
 *  way a real host reads one cookie twice. NOTHING here is annotated: if the
 *  union needed a cast or a type argument to accept a hand-written door, this
 *  file would not compile (`tsconfig.test.json` is in `pnpm typecheck`). */
const session = (req: Request): string | null => req.headers.get("x-host-session");

const objectSpelling: Spelling = {
  label: "an object — auth: { principal, facts }",
  auth: {
    principal: async (req) => {
      const subject = session(req);
      return subject === null ? null : { kind: "user", subject };
    },
    facts: async (req) => (session(req) === "host_mia" ? { ...MIA } : undefined),
  },
  headers: async (subject) => ({ "x-host-session": subject }),
};

async function compose(auth: HostAuthPreset): Promise<{ vendo: Vendo; seen: string[] }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-user-facts-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const seen: string[] = [];
  const vendo = createVendo({ models: { default: recordingModel(seen) }, auth, store });
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

describe.each([presetSpelling, objectSpelling])(
  "[User] facts — $label — through the real wire into the real prompt",
  ({ auth, headers }) => {
    it("renders the resolver's facts as the [User] block", async () => {
      const { vendo, seen } = await compose(auth);
      await (await post(vendo, { threadId: "thr_facts_1", message: userMessage("m1", "hello") }, await headers("host_mia"))).text();
      expect(seen[0]).toContain(MIA_BLOCK);
    });

    it("renders no [User] block when the seam asserts nothing about the user", async () => {
      const { vendo, seen } = await compose(auth);
      await (await post(vendo, { threadId: "thr_facts_2", message: userMessage("m2", "hello") }, await headers("host_other"))).text();
      expect(seen[0]).not.toContain("[User]");
    });
  },
);

/**
 * The half a table cannot state: an `auth` object with NO `facts` member is
 * still a whole identity — it serves the turn and renders no block. This is the
 * shape `vendo init --auth none` now writes, so a regression that made `facts`
 * mandatory (or made a memberless `auth` fail to compose) would hit every new
 * host on their first request.
 */
describe("a hand-written door with `principal` alone", () => {
  const bare: HostAuthPreset = {
    principal: async (req) => {
      const subject = session(req);
      return subject === null ? null : { kind: "user", subject };
    },
  };

  it("serves the turn and asserts nothing about the user", async () => {
    const { vendo, seen } = await compose(bare);
    const response = await post(
      vendo,
      { threadId: "thr_facts_3", message: userMessage("m3", "hello") },
      { "x-host-session": "host_mia" },
    );
    await response.text();
    expect(response.status).toBe(200);
    expect(seen[0]).not.toContain("[User]");
  });

  it("refuses a visitor it cannot place, exactly as a preset does", async () => {
    const { vendo } = await compose(bare);
    const response = await post(vendo, { threadId: "thr_facts_4", message: userMessage("m4", "hello") });
    expect(response.status).toBe(403);
  });
});

/**
 * The deprecated per-seam trio keeps working — a `@deprecated` tag is advice,
 * never a break, and a hard break may never land in a minor. Proven through the
 * same wire, against the same route: a host on `principal:` sees exactly what
 * they saw before, minus the facts channel that key never had.
 */
describe("the deprecated top-level `principal` still works", () => {
  it("resolves the caller and renders no [User] block", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-user-facts-loose-"));
    const store: VendoStore = createStore({ dataDir });
    cleanups.push(async () => {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const seen: string[] = [];
    const vendo = createVendo({
      models: { default: recordingModel(seen) },
      principal: async (req) => {
        const subject = session(req);
        return subject === null ? null : { kind: "user", subject };
      },
      store,
    });
    const response = await post(
      vendo,
      { threadId: "thr_facts_5", message: userMessage("m5", "hello") },
      { "x-host-session": "host_mia" },
    );
    await response.text();
    expect(response.status).toBe(200);
    expect(seen[0]).not.toContain("[User]");
  });

  it("still refuses to compose beside `auth` — one door or the trio, never mixed", async () => {
    expect(() => createVendo({
      models: { default: {} as LanguageModel },
      auth: { principal: async () => null },
      principal: async () => null,
    })).toThrow(/never mixed/);
  });
});

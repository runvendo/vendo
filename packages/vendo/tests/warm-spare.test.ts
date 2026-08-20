/**
 * The box a WARM call boots must be the box the CONVERSATION gets.
 *
 * `HarnessTurns.warm` replays a real turn under a throwaway thread id
 * (`WARM_THREAD_PREFIX`), and the sandbox leg pools boxes per thread. Those two
 * facts together made warming worse than useless on this rung: the warm turn
 * booted a real cloud machine, hello'd it, materialized it — and the user's first
 * message arrived under its OWN thread id, missed the pool, and paid a full cold
 * boot anyway, while the warm box idled its whole billed TTL and was destroyed
 * unused. Every warm call was a guaranteed miss.
 *
 * The seam this covers is a producer and a consumer in different blocks: vendo's
 * warm door mints the id, the harnesses box pool reads it. Both halves are REAL
 * here — the actual `POST /threads/warm` and `POST /threads`, the actual
 * `createVendo` composition, the actual `claudeCode()` driver, the actual box
 * door (`packages/harnesses/box/turn-routes.mjs`) over an in-process transport.
 * The SandboxAdapter is the one thing faked, because it is the legitimate BYO
 * boundary; the SDK loop inside the box is scripted, because a test cannot run a
 * model.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel, UIMessage } from "ai";
import type { Principal } from "@vendoai/core";
import { createSessionRoutes } from "@vendoai/harnesses/box-door";
import { claudeCode, disposeSessionMachines } from "@vendoai/harnesses/claude-code";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { liveDoor } from "../src/agent-doubles.test-util.js";
import { createVendo, type Vendo } from "../src/server.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const principal: Principal = { kind: "user", subject: "user_spare" };

const cleanups: Array<() => Promise<void>> = [];
const boxRoots: string[] = [];
afterEach(async () => {
  // The pool is module-scoped, and so is the spare slot: without this, one case's
  // spare would be claimed by the next case's turn.
  await disposeSessionMachines();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of boxRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One machine, as a test can see it. */
interface FakeBox {
  id: string;
  /** Every session the REAL door opened on this machine, in order — what it was
   *  asked to resume, and every prompt that session was sent. A claimed spare
   *  carries the probe's live session, so "did the user's first message land in a
   *  SECOND session that resumes nothing" is the whole question. */
  opens: Array<{ resume?: string; prompts: string[] }>;
  /** The provider reaping the machine out from under us — no notice, no error,
   *  the box simply stops answering. */
  kill: () => void;
}

/**
 * A stand-in for a real box, adapted from the fake in
 * `packages/vendo/tests/claude-code-composed.test.ts`: `request()` is a transport
 * adapter over the ACTUAL box door, so the session protocol under test is the
 * real one — including the reopen rule a claimed spare depends on.
 */
function fakeSandbox(): {
  create: (spec: { env: Record<string, string> }) => Promise<unknown>;
  destroy: (ref: string) => Promise<void>;
  boxes: FakeBox[];
} {
  const boxes: FakeBox[] = [];
  return {
    boxes,
    async create() {
      const root = mkdtempSync(join(tmpdir(), "vendo-spare-box-"));
      boxRoots.push(root);
      let dead = false;
      const box: FakeBox = {
        id: `box_${boxes.length}`,
        opens: [],
        kill: () => { dead = true; },
      };
      boxes.push(box);
      const routes = createSessionRoutes({
        root,
        // Unclaimed, so the host's first `/session/hello` claims it.
        token: "",
        env: {},
        openSession: (input: {
          emit: (event: Record<string, unknown>) => void;
          resume?: string;
        }) => {
          const session: { resume?: string; prompts: string[] } = {
            ...(input.resume === undefined ? {} : { resume: input.resume }),
            prompts: [],
          };
          box.opens.push(session);
          return {
            async send(prompt: string) {
              session.prompts.push(prompt);
              // A session id the door will remember — without one, "resumed
              // nothing" would be true of every session and prove nothing.
              input.emit({ type: "session", sessionId: `sess_${box.id}_${box.opens.length}` });
              input.emit({ type: "text", delta: "Nothing is open." });
            },
            async interrupt() { /* the turn stops; the session lives */ },
            async end() { /* the box is going away */ },
          };
        },
      }) as {
        handle: (method: string, pathname: string, headers: Record<string, string>, payload: unknown)
          => Promise<{ status: number; body: unknown }>;
      };
      return {
        id: box.id,
        async request(req: {
          method: string;
          path: string;
          headers?: Record<string, string>;
          body?: Uint8Array | string;
        }) {
          if (dead) throw new Error("machine is gone");
          const payload = req.body === undefined
            ? {}
            : JSON.parse(typeof req.body === "string" ? req.body : decoder.decode(req.body)) as unknown;
          const answer = await routes.handle(req.method, req.path, req.headers ?? {}, payload);
          return { status: answer.status, headers: {}, body: encoder.encode(JSON.stringify(answer.body)) };
        },
        async destroy() { dead = true; },
      };
    },
    async destroy() { /* no machine to reap by ref */ },
  };
}

async function compose(sandbox: unknown): Promise<Vendo> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-spare-"));
  const store: VendoStore = createStore({ dataDir });
  const door = await liveDoor();
  cleanups.push(door.close);
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return createVendo({
    // Never reached: the thinker is the scripted box, not a provider.
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    // A composed `claudeCode()` refuses a turn whose door nothing answers, so the
    // origin has to be one a machine could really dial — and the door mints its
    // principals through the oauth seam, so it cannot open without one.
    mcp: { baseUrl: door.origin },
    oauth: {
      async authorize() { return { subject: principal.subject }; },
      async principal(subject: string) { return { kind: "user" as const, subject }; },
    },
    sandbox,
    harness: claudeCode(),
  } as Parameters<typeof createVendo>[0]);
}

const post = (vendo: Vendo, path: string, body: unknown = {}): Promise<Response> =>
  vendo.handler(new Request(`https://host.test/api/vendo${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

const firstMessage = (vendo: Vendo, threadId: string): Promise<Response> =>
  post(vendo, "/threads", {
    threadId,
    message: { id: "m1", role: "user", parts: [{ type: "text", text: "how many invoices are open?" }] } as UIMessage,
  });

describe("a warm turn's box is parked as a spare the conversation claims", () => {
  it("warm boots ONE box, and the first real message runs on it instead of booting another", async () => {
    const sandbox = fakeSandbox();
    const vendo = await compose(sandbox);

    expect((await post(vendo, "/threads/warm")).status).toBe(204);
    // The probe really did boot a machine — otherwise everything below is vacuous.
    expect(sandbox.boxes).toHaveLength(1);
    expect(sandbox.boxes[0]!.opens).toHaveLength(1);

    const turn = await firstMessage(vendo, "thr_claims_the_spare");
    expect(turn.status).toBe(200);
    const body = await turn.text();
    expect(body).not.toContain("missing its workspace machine");
    expect(body).toContain("Nothing is open.");

    // THE assertion: the user's first message paid for no boot at all.
    expect(sandbox.boxes).toHaveLength(1);

    // …and it is the user's conversation on that machine, not the probe's. The
    // spare's session is live on its disk, so the claim closes it and opens one
    // that resumes NOTHING; the probe's session never sees the user's words.
    const [spare] = sandbox.boxes as [FakeBox];
    expect(spare.opens).toHaveLength(2);
    expect(spare.opens[1]!.resume).toBeUndefined();
    expect(spare.opens[0]!.prompts.join("\n")).not.toContain("invoices");
    expect(spare.opens[1]!.prompts.join("\n")).toContain("invoices");
  });

  it("a second warm while a live spare is parked boots no second box", async () => {
    const sandbox = fakeSandbox();
    const vendo = await compose(sandbox);

    expect((await post(vendo, "/threads/warm")).status).toBe(204);
    expect((await post(vendo, "/threads/warm")).status).toBe(204);

    expect(sandbox.boxes).toHaveLength(1);
  });

  it("a spare the provider reaped is not handed out — the conversation boots cold", async () => {
    const sandbox = fakeSandbox();
    const vendo = await compose(sandbox);

    expect((await post(vendo, "/threads/warm")).status).toBe(204);
    expect(sandbox.boxes).toHaveLength(1);
    // Gone without us asking, which is the one thing a pool may never assume away.
    sandbox.boxes[0]!.kill();

    const turn = await firstMessage(vendo, "thr_spare_was_dead");
    expect(turn.status).toBe(200);
    expect(await turn.text()).toContain("Nothing is open.");

    expect(sandbox.boxes).toHaveLength(2);
    // The replacement is a FRESH box carrying the user's conversation and nothing
    // else: one session, resuming nothing.
    expect(sandbox.boxes[1]!.opens).toHaveLength(1);
    expect(sandbox.boxes[1]!.opens[0]!.resume).toBeUndefined();
  });
});

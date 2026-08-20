/**
 * The workspace upload is the one network call a turn makes before the model
 * runs, and until now it was the one with nothing behind it.
 *
 * When it dies BEFORE the box applies it — a refused connect, a dead socket, a
 * first chunk that never lands — the box is left holding an empty disk. The
 * turn's `finally` then reads that disk back honestly, and the sync-back reads
 * "nothing here" as "the user deleted everything" and erases the baseline from
 * the store. The failed-READ half of that seam is already guarded ("an EMPTY
 * read is not the same fact as the user deleted everything"); this is the same
 * fact from the other end, and it had no guard and no test.
 *
 * Observed live once on a warm-probe turn, as a bare `TypeError: fetch failed`.
 */
import { VendoError, type HarnessEvent, type Turn } from "@vendoai/core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createSessionRoutes } from "../../box/turn-routes.mjs";
import { boxMachine, disposeSessionMachines, type SandboxAdapterLike, type SandboxMachineLike } from "../../src/claude-code/box.js";
import { claudeCode } from "../../src/claude-code/index.js";
import { createTurnState } from "../../src/harness-state.js";
import { testWorkspace, unusedModels, userMessage } from "../../src/test-doubles.test-util.js";

const encoder = new TextEncoder();
const SCREEN = "/user/apps/app_1/app.tsx";

const boxRoots: string[] = [];
afterEach(async () => {
  await disposeSessionMachines();
  for (const root of boxRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** What undici hands back for a connection that died: three words, and the real
 *  reason only on the cause. */
const fetchFailed = (): Error =>
  Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNRESET") });

const answer = (body: unknown): { status: number; headers: Record<string, string>; body: Uint8Array } =>
  ({ status: 200, headers: {}, body: encoder.encode(JSON.stringify(body)) });

/**
 * A box that greets, is asked to take the workspace, and never gets it — and
 * then answers the turn-end read HONESTLY, because from its side the disk really
 * is empty. That honesty is what makes the sync-back dangerous.
 */
function boxThatNeverReceivesTheWorkspace(): SandboxAdapterLike {
  const machine: SandboxMachineLike = {
    id: "box_lost",
    async request(req) {
      if (req.path === "/session/workspace") throw fetchFailed();
      if (req.path === "/session/collect") return answer({ files: [] });
      return answer({ ok: true });
    },
    files: { read: async () => new Uint8Array(), write: async () => undefined, list: async () => [] },
    url: async () => "https://box_lost.fake-provider.test",
    destroy: async () => undefined,
  };
  return { create: async () => machine, destroy: async () => undefined };
}

function turnOver(workspace: ReturnType<typeof testWorkspace>): Turn<never> {
  return {
    threadId: "thr_loss",
    messages: [userMessage("m1", "make me a dashboard")],
    tools: { list: async () => [], call: async () => ({ status: "ok" as const, output: {} }) },
    skills: { list: async () => [], load: async () => "" },
    workspace,
    models: unusedModels(),
    state: createTurnState(undefined),
    options: {} as never,
    signal: new AbortController().signal,
    interactive: true,
    system: "PRODUCT BRIEF",
  } as unknown as Turn<never>;
}

const drain = async (workspace: ReturnType<typeof testWorkspace>): Promise<unknown> => {
  const harness = claudeCode({ sandbox: boxThatNeverReceivesTheWorkspace() });
  const events: HarnessEvent[] = [];
  return await (async () => {
    for await (const event of harness.run(turnOver(workspace) as never)) events.push(event);
  })().catch((thrown: unknown) => thrown);
};

test("a workspace the box never received is not the user deleting everything", async () => {
  const workspace = testWorkspace({ [SCREEN]: "<App/>" });

  await drain(workspace);

  expect(await workspace.readFile(SCREEN)).toBe("<App/>");
  // Nothing was written back at all: a turn whose box never held the workspace
  // has no statement to make about it.
  expect(workspace.commits).toEqual([]);
});

test("a box that cannot be reached says so, instead of three words from undici", async () => {
  const thrown = await drain(testWorkspace({ [SCREEN]: "<App/>" }));

  expect(thrown).toBeInstanceOf(VendoError);
  expect((thrown as VendoError).code).toBe("sandbox-unavailable");
  expect((thrown as VendoError).detail).toMatchObject({ cause: expect.any(TypeError) });
});

test("a workspace upload that dies on the transport is sent again", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vendo-materialize-retry-"));
  boxRoots.push(root);
  const routes = createSessionRoutes({ root, token: "", env: {} }) as {
    handle: (method: string, pathname: string, headers: Record<string, string>, payload: unknown)
      => Promise<{ status: number; body: unknown }>;
  };
  let dropped = 0;
  const sandbox: SandboxAdapterLike = {
    async create() {
      return {
        id: "box_blip",
        async request(req) {
          // Once, on the leg that carries the files, and BEFORE the box sees it:
          // the upload never applied, which is the half of the live failure that
          // costs the turn. The other half — applied, and only the answer died —
          // is where a replay can do damage rather than just cost a round trip,
          // and it is proved against the real door in
          // `materialize-generation.test.ts` ("a first chunk sent twice does not
          // take the chunks that landed behind it").
          if (req.path === "/session/workspace" && dropped === 0) {
            dropped += 1;
            throw fetchFailed();
          }
          const payload = req.body === undefined
            ? {}
            : JSON.parse(typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body));
          const reply = await routes.handle(req.method, req.path, (req.headers ?? {}) as Record<string, string>, payload);
          return { status: reply.status, headers: {}, body: encoder.encode(JSON.stringify(reply.body)) };
        },
        files: { read: async () => new Uint8Array(), write: async () => undefined, list: async () => [] },
        url: async () => "https://box_blip.fake-provider.test",
        destroy: async () => undefined,
      };
    },
    async destroy() { /* no machine to reap by ref */ },
  };

  const machine = await boxMachine({ sandbox, threadId: "thr_blip", env: {}, allowedDomains: [] });
  await machine.materialize([{ path: SCREEN, bytes: encoder.encode("<App/>"), readOnly: false }]);

  expect(dropped).toBe(1);
  expect(readFileSync(path.join(root, SCREEN.replace(/^\/+/, "")), "utf8")).toBe("<App/>");
});

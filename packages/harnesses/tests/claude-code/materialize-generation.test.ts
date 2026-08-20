/**
 * The retry that saved the upload made the upload replayable — and a replay is
 * only safe if the box can tell it from a ghost.
 *
 * `AbortSignal.timeout` aborts the HOST's leg of a call and nothing else: the
 * console→box hop behind it keeps going. So chunk 0 of an attempt this host gave
 * up on can still land — after its own replay, after the chunks that followed it,
 * even after the model started writing — and chunk 0 carries `reset`, which empties
 * the root. The turn then reads a truncated disk and the sync-back commits the
 * difference as deletions.
 *
 * The same fact wearing a different hat: a box whose supervisor RESTARTED answers
 * hello, answers collect, and holds nothing. `carriesSession` is this host's
 * memory of a machine, never the machine's own state.
 *
 * So every materialize mints a GENERATION and carries it on every chunk. The box
 * refuses a generation it has moved past, resets once per generation rather than
 * once per request, and reports what it holds — which is how the host knows the
 * disk it is reading is the disk it wrote.
 */
import { setLogger, type HarnessEvent, type Turn, type VendoLogEvent } from "@vendoai/core";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createSessionRoutes } from "../../box/turn-routes.mjs";
import { boxMachine, disposeSessionMachines, type SandboxAdapterLike, type SandboxMachineLike } from "../../src/claude-code/box.js";
import { claudeCode } from "../../src/claude-code/index.js";
import { createTurnState } from "../../src/harness-state.js";
import { testWorkspace, unusedModels, userMessage } from "../../src/test-doubles.test-util.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SCREEN = "/user/apps/app_1/app.tsx";

const roots: string[] = [];
afterEach(async () => {
  setLogger(undefined);
  await disposeSessionMachines();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Door {
  handle(method: string, pathname: string, headers: Record<string, string>, payload: unknown):
    Promise<{ status: number; body: unknown }>;
}

const newRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "vendo-generation-"));
  roots.push(root);
  return root;
};

/** The real box door on a real disk, already claimed by one hello. */
const openDoor = async (root: string): Promise<Door> => {
  const door = createSessionRoutes({ root, token: "", env: {} }) as Door;
  await door.handle("POST", "/session/hello", {}, { token: "bxt_test" });
  return door;
};

const upload = async (door: Door, payload: unknown): Promise<{ status: number; body: unknown }> =>
  await door.handle("POST", "/session/workspace", { "x-vendo-box-token": "bxt_test" }, payload);

const wireFile = (at: string, text: string): unknown =>
  ({ path: at, base64: Buffer.from(text).toString("base64") });

const onDisk = (root: string, at: string): string => readFileSync(path.join(root, at.replace(/^\/+/, "")), "utf8");

test("a chunk from a materialize the box has moved past cannot wipe the one that replaced it", async () => {
  const root = newRoot();
  const door = await openDoor(root);

  await upload(door, { epoch: 1, reset: true, files: [wireFile("/user/first.txt", "one")] });
  await upload(door, { epoch: 2, reset: true, files: [wireFile("/user/second.txt", "two")] });
  // Attempt 1 of generation 1, arriving now: this host stopped waiting for it
  // minutes ago and nothing ever cancelled the hop.
  const late = await upload(door, { epoch: 1, reset: true, files: [wireFile("/user/first.txt", "one")] });

  expect(late.status).toBe(409);
  expect(onDisk(root, "/user/second.txt")).toBe("two");
  expect(existsSync(path.join(root, "user/first.txt"))).toBe(false);
});

test("a first chunk sent twice does not take the chunks that landed behind it", async () => {
  const root = newRoot();
  const door = await openDoor(root);

  await upload(door, { epoch: 1, reset: true, files: [wireFile("/user/first.txt", "one")] });
  await upload(door, { epoch: 1, files: [wireFile("/user/second.txt", "two")] });
  // The replay the transport retry sends: the same bytes to the same path, which
  // is the promise `repeatable` makes — and it must stay true of the whole disk.
  await upload(door, { epoch: 1, reset: true, files: [wireFile("/user/first.txt", "one")] });

  expect(onDisk(root, "/user/first.txt")).toBe("one");
  expect(onDisk(root, "/user/second.txt")).toBe("two");
});

test("a box whose supervisor restarted is not the box that holds the workspace", async () => {
  // One real door per machine, each on its own disk — a box the provider hands
  // over boots with no token, and the first hello claims it.
  const doors = new Map<string, Door>();
  const boot = (id: string): Door => {
    const door = createSessionRoutes({ root: newRoot(), token: "", env: {} }) as Door;
    doors.set(id, door);
    return door;
  };
  let created = 0;
  const sandbox: SandboxAdapterLike = {
    async create() {
      created += 1;
      const id = `box_restart_${created}`;
      boot(id);
      return {
        id,
        async request(req) {
          const payload = req.body === undefined
            ? {}
            : JSON.parse(typeof req.body === "string" ? req.body : decoder.decode(req.body));
          const door = doors.get(id) as Door;
          const reply = await door.handle(req.method, req.path, (req.headers ?? {}) as Record<string, string>, payload);
          return { status: reply.status, headers: {}, body: encoder.encode(JSON.stringify(reply.body)) };
        },
        files: { read: async () => new Uint8Array(), write: async () => undefined, list: async () => [] },
        url: async () => "https://box_restart.fake-provider.test",
        destroy: async () => undefined,
      } satisfies SandboxMachineLike;
    },
    async destroy() { /* no machine to reap by ref */ },
  };

  const machine = await boxMachine({ sandbox, threadId: "thr_restart", env: {}, allowedDomains: [] });
  await machine.materialize([{ path: SCREEN, bytes: encoder.encode("<App/>"), readOnly: false }]);

  // The supervisor comes back: a fresh process on an empty disk holding no token
  // of its own — the provider does not hand create-time env to a template's start
  // command, so the next hello simply claims it again, exactly as the first one
  // did. Answering is all a box has to do to be believed.
  boot("box_restart_1");
  const lines: VendoLogEvent[] = [];
  setLogger((event) => lines.push(event));

  const next = await boxMachine({ sandbox, threadId: "thr_restart", env: {}, allowedDomains: [] });

  expect(created).toBe(2);
  expect(next.carriesSession).toBe(false);
  expect(lines.find((line) => line.code === "harnesses.claude-code-box-stale")?.message)
    .toMatch(/no longer holds the workspace/);
});

/** A box that takes the workspace, answers one message, and then reads back as a
 *  machine that never got it — the restart, from the store's side. */
function boxThatForgetsMidTurn(): SandboxAdapterLike {
  const machine: SandboxMachineLike = {
    id: "box_amnesiac",
    async request(req) {
      const body = (payload: unknown): { status: number; headers: Record<string, string>; body: Uint8Array } =>
        ({ status: 200, headers: {}, body: encoder.encode(JSON.stringify(payload)) });
      if (req.path === "/session/message") return body({ messageId: "msg_1" });
      if (req.path.endsWith("/poll")) return body({ events: [{ type: "text", delta: "done" }], cursor: 1, done: true });
      // Generation zero: everything this host put here is gone.
      if (req.path === "/session/collect") return body({ files: [], epoch: 0 });
      return body({ ok: true, epoch: 0 });
    },
    files: { read: async () => new Uint8Array(), write: async () => undefined, list: async () => [] },
    url: async () => "https://box_amnesiac.fake-provider.test",
    destroy: async () => undefined,
  };
  return { create: async () => machine, destroy: async () => undefined };
}

function turnOver(workspace: ReturnType<typeof testWorkspace>): Turn<never> {
  return {
    threadId: "thr_forget",
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

test("a box that forgot the workspace mid-turn does not get to delete it", async () => {
  const workspace = testWorkspace({ [SCREEN]: "<App/>" });
  const harness = claudeCode({ sandbox: boxThatForgetsMidTurn() });
  const seen: HarnessEvent[] = [];

  for await (const event of harness.run(turnOver(workspace) as never)) seen.push(event);

  expect(await workspace.readFile(SCREEN)).toBe("<App/>");
  expect(workspace.commits).toEqual([]);
});

test("the turn says out loud that nothing was synced back", async () => {
  const lines: VendoLogEvent[] = [];
  setLogger((event) => lines.push(event));
  const lost: SandboxAdapterLike = {
    create: async () => ({
      id: "box_lost",
      async request(req) {
        if (req.path === "/session/workspace") throw new TypeError("fetch failed");
        return { status: 200, headers: {}, body: encoder.encode(JSON.stringify({ ok: true })) };
      },
      files: { read: async () => new Uint8Array(), write: async () => undefined, list: async () => [] },
      url: async () => "https://box_lost.fake-provider.test",
      destroy: async () => undefined,
    }),
    destroy: async () => undefined,
  };
  const harness = claudeCode({ sandbox: lost });

  const events: HarnessEvent[] = [];
  await (async () => {
    for await (const event of harness.run(turnOver(testWorkspace({ [SCREEN]: "<App/>" })) as never)) events.push(event);
  })().catch(() => undefined);

  expect(lines.map((line) => line.code)).toContain("harnesses.claude-code-workspace-not-materialized");
});

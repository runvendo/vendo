/**
 * The sandbox harness reaches a TEAM file — build contract §3.5 over §9.7.
 *
 * Wave 3 shipped orgs, teams and sharing, and the sandbox path never learned:
 * `claudeCode()` materialized `/user` and `/host` and dropped every
 * `/orgs/<org>/**` path on the floor, then filtered the same paths out of the
 * sync-back. Same user, same ask, on `vendo()`: worked. So "update our team's
 * Quarterly Report app" answered that it does not exist — or edited it, said
 * "done", and dropped the write with no error anywhere.
 *
 * Everything here is REAL except the model: a real store, the real `can()`, real
 * grants, the real composition, and the real box door
 * (`packages/apps/box/turn-routes.mjs`) over an in-process transport with a real
 * temp dir for the box's disk. Only the SDK loop is scripted, because a test
 * cannot run a model — so what the script does to that disk is exactly what a
 * model's Write tool would do.
 */
import { mkdtemp, readFile, rm, stat, writeFile, chmod, mkdir } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LanguageModel, UIMessage } from "ai";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Membership,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import type { SandboxAdapter } from "@vendoai/apps";
import { createSessionRoutes } from "@vendoai/apps/box-door";
import { claudeCode } from "@vendoai/harnesses/claude-code";
import { appAccess, createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "./server.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ORG = "acme";
const APP = "app_quarterly";
const APP_PATH = `/orgs/${ORG}/apps/${APP}/app.vendo`;

const dana: Principal = { kind: "user", subject: "dana" };
const kim: Principal = { kind: "user", subject: "kim" };

const memberships: Record<string, Membership[]> = {
  dana: [{ org: ORG, display: "Acme", admin: true }],
  kim: [{ org: ORG, display: "Acme" }],
};

const ctxOf = (principal: Principal): RunContext => ({
  principal,
  memberships: memberships[principal.subject] ?? [],
  venue: "app",
  presence: "present",
  sessionId: `s_${principal.subject}`,
});

const cleanups: Array<() => Promise<void>> = [];
const boxRoots: string[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of boxRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-orgs-materialize-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  return store;
}

const seeded = (id: string, name: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name,
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
});

/** What the scripted SDK loop inside the box is handed: the box's own disk, and
 *  the emit sink its events leave through. */
interface BoxScript {
  root: string;
  emit: (event: Record<string, unknown>) => void;
}

interface BoxDoor {
  handle: (method: string, pathname: string, headers: Record<string, string>, payload: unknown)
    => Promise<{ status: number; body: unknown }>;
}

/** The REAL box door over an in-process transport, on a real temp dir. Adapted
 *  from `claude-code-composed.test.ts`, plus the root, because what is (and is
 *  not) on that disk is the whole subject of this file. */
function fakeSandbox(script: (box: BoxScript) => Promise<void>) {
  const adapter = {
    creates: 0,
    async create() {
      adapter.creates += 1;
      const root = mkdtempSync(join(tmpdir(), "vendo-orgbox-"));
      boxRoots.push(root);
      const routes = createSessionRoutes({
        root,
        token: "",
        env: {},
        openSession: (input: { emit: (event: Record<string, unknown>) => void }) => ({
          async send() {
            await script({ root, emit: input.emit });
          },
          async interrupt() { /* the turn stops; the session lives */ },
          async end() { /* the box is going away */ },
        }),
      }) as BoxDoor;
      return {
        id: `box_${adapter.creates - 1}`,
        async request(req: {
          method: string;
          path: string;
          headers?: Record<string, string>;
          body?: Uint8Array | string;
        }) {
          const payload = req.body === undefined
            ? {}
            : JSON.parse(typeof req.body === "string" ? req.body : decoder.decode(req.body)) as unknown;
          const answer = await routes.handle(req.method, req.path, req.headers ?? {}, payload);
          return { status: answer.status, headers: {}, body: encoder.encode(JSON.stringify(answer.body)) };
        },
        async destroy() { /* nothing outlives the test */ },
      };
    },
    async destroy() { /* no machine to reap by ref */ },
  };
  return adapter;
}

/** Whose request this is — set per call, the way a real session would. */
let acting: Principal = kim;

async function boot(store: VendoStore, sandbox: ReturnType<typeof fakeSandbox>): Promise<Vendo> {
  const vendo = createVendo({
    // Never reached: the thinker is the scripted box, not a provider.
    model: {} as LanguageModel,
    store,
    sandbox: sandbox as unknown as SandboxAdapter,
    harness: claudeCode(),
    mcp: { baseUrl: "https://host.test" },
    // One preset, four seams (09-vendo §2.1) — `memberships` is the one this
    // file is about, and `oauth` is what lets the box's MCP door open at all.
    auth: {
      principal: async () => acting,
      memberships: async (principal: Principal) => memberships[principal.subject] ?? [],
      oauth: {
        async authorize() { return { subject: acting.subject }; },
        async principal(subject: string) { return { kind: "user" as const, subject }; },
      },
    },
  });
  return vendo;
}

const userMessage = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

async function turnAs(vendo: Vendo, who: Principal, threadId: string, text: string): Promise<string> {
  acting = who;
  const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId, message: userMessage(`m_${threadId}`, text) }),
  }));
  return await response.text();
}

/** Put the team's app in the org's workspace, with `level` for Kim. */
async function seedTeamApp(
  store: VendoStore,
  vendo: Vendo,
  level: "editor" | "viewer",
): Promise<void> {
  await store.records("vendo_apps").put({
    id: APP,
    data: { subject: ORG, enabled: false, doc: seeded(APP, "Quarterly Report") },
    refs: { subject: ORG },
  });
  await appAccess(store).grant(ctxOf(dana), APP, `user:${kim.subject}`, level);
  acting = dana;
  const fs = await vendo.harness.workspace(dana);
  await fs.writeFile(APP_PATH, "page: quarterly");
  expect(await fs.commit()).toEqual({ status: "ok", changed: [APP_PATH] });
}

/** What the store holds at `path` for a caller who may read it. */
async function stored(vendo: Vendo, who: Principal, path: string): Promise<string | undefined> {
  acting = who;
  const fs = await vendo.harness.workspace(who);
  try {
    return await fs.readFile(path);
  } catch {
    return undefined;
  }
}

describe("a team file reaches the claudeCode() sandbox", () => {
  it("gate ① — an org file the caller may edit is on the box's disk, writable", async () => {
    let onDisk: string | undefined;
    let mode: number | undefined;
    const sandbox = fakeSandbox(async (box) => {
      const disk = join(box.root, APP_PATH.replace(/^\//, ""));
      onDisk = await readFile(disk, "utf8").catch(() => undefined);
      mode = await stat(disk).then((entry) => entry.mode & 0o777, () => undefined);
      box.emit({ type: "text", delta: "read it" });
    });
    const store = await tempStore();
    const vendo = await boot(store, sandbox);
    await seedTeamApp(store, vendo, "editor");

    await turnAs(vendo, kim, "thr_visible", "what does our quarterly app say?");

    // Wave 3's whole point: the team's file is the same file, and the box is
    // born filtered — it is THERE, not absent.
    expect(onDisk).toBe("page: quarterly");
    // Editor level ⇒ WRITABLE. Asserted as the owner-write bit rather than an
    // exact `0o644`, because the door only ever chmods the read-only case: a
    // writable file keeps whatever `writeFileSync` produced under the running
    // umask, and pinning 644 would fail for anyone with a different one.
    // Read-only IS pinned exactly (0o444), because there the door sets it.
    expect(mode).toBeDefined();
    expect(mode! & 0o200).toBe(0o200);
  });

  it("gate ② — the edit the box makes to a team file LANDS in the store", async () => {
    const sandbox = fakeSandbox(async (box) => {
      const disk = join(box.root, APP_PATH.replace(/^\//, ""));
      await mkdir(dirname(disk), { recursive: true });
      await writeFile(disk, "page: quarterly (Q3)");
      // The user's own memory file changes in the same turn: an org path must
      // not be able to take the personal half down with it, either way.
      const mine = join(box.root, "user/memory/notes.md");
      await mkdir(dirname(mine), { recursive: true });
      await writeFile(mine, "kim's note");
      box.emit({ type: "text", delta: "updated" });
    });
    const store = await tempStore();
    const vendo = await boot(store, sandbox);
    await seedTeamApp(store, vendo, "editor");

    await turnAs(vendo, kim, "thr_edit", "add Q3 to the quarterly app");

    expect(await stored(vendo, kim, APP_PATH)).toBe("page: quarterly (Q3)");
    expect(await stored(vendo, kim, "/user/memory/notes.md")).toBe("kim's note");
  });

  it("viewer level materializes READ-ONLY, and a write anyway never lands", async () => {
    let mode: number | undefined;
    const sandbox = fakeSandbox(async (box) => {
      const disk = join(box.root, APP_PATH.replace(/^\//, ""));
      mode = await stat(disk).then((entry) => entry.mode & 0o777, () => undefined);
      // The refusal the model actually meets is the mode on this file. A box
      // process runs as the file's owner and CAN chmod it back, which is why
      // the sync-back asks `can(editor)` again against live rows.
      await chmod(disk, 0o644).catch(() => undefined);
      await writeFile(disk, "page: vandalised").catch(() => undefined);
      box.emit({ type: "text", delta: "tried" });
    });
    const store = await tempStore();
    const vendo = await boot(store, sandbox);
    await seedTeamApp(store, vendo, "viewer");

    await turnAs(vendo, kim, "thr_viewer", "rewrite the quarterly app");

    // Visible, and refused at the moment of the write rather than after the work.
    expect(mode).toBe(0o444);
    expect(await stored(vendo, kim, APP_PATH)).toBe("page: quarterly");
  });

  it("an org file the caller holds NO grant on is not on the disk at all", async () => {
    let present: boolean | undefined;
    const sandbox = fakeSandbox(async (box) => {
      const disk = join(box.root, APP_PATH.replace(/^\//, ""));
      present = await stat(disk).then(() => true, () => false);
      box.emit({ type: "text", delta: "nothing to see" });
    });
    const store = await tempStore();
    const vendo = await boot(store, sandbox);
    await store.records("vendo_apps").put({
      id: APP,
      data: { subject: ORG, enabled: false, doc: seeded(APP, "Quarterly Report") },
      refs: { subject: ORG },
    });
    acting = dana;
    const fs = await vendo.harness.workspace(dana);
    await fs.writeFile(APP_PATH, "page: quarterly");
    await fs.commit();

    await turnAs(vendo, kim, "thr_ungranted", "open the quarterly app");

    // §9.4 existence-masking reaches the disk too: no grant, no file.
    expect(present).toBe(false);
  });

  it("/host stays read-only, and the box's write to it never syncs back", async () => {
    const HOST_PATH = "/host/skills/building-apps/SKILL.md";
    let mode: number | undefined;
    const sandbox = fakeSandbox(async (box) => {
      const disk = join(box.root, HOST_PATH.replace(/^\//, ""));
      mode = await stat(disk).then((entry) => entry.mode & 0o777, () => undefined);
      await chmod(disk, 0o644).catch(() => undefined);
      await writeFile(disk, "# rewritten by the box").catch(() => undefined);
      box.emit({ type: "text", delta: "poked host" });
    });
    const store = await tempStore();
    const vendo = await boot(store, sandbox);

    acting = kim;
    const before = await (await vendo.harness.workspace(kim)).readFile(HOST_PATH);
    await turnAs(vendo, kim, "thr_host", "rewrite the host skill");

    // `/host` is a per-turn projection of code-defined skills, never store
    // rows: it materializes read-only, and nothing written there comes home.
    expect(mode).toBe(0o444);
    acting = kim;
    expect(await (await vendo.harness.workspace(kim)).readFile(HOST_PATH)).toBe(before);
  });
});

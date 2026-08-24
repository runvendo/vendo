/**
 * S4 — the build lane, from the person's yes to a sealed bundle.
 *
 * Real on every axis this slice owns: the real apps runtime and its real build
 * door, the REAL guard (so the decision that starts a build is the one a person
 * really makes, and `decide` really awaits its subscribers), the real box pool
 * (`boxMachine`), the real box session door
 * (`packages/harnesses/box/turn-routes.mjs`) over an in-process transport, and
 * the real seal. Two things are stand-ins, both the legitimate BYO boundary: the
 * SandboxAdapter, and the coding agent inside the box — a test cannot run a
 * model, so the script writes the files a real in-box agent would write.
 *
 * The store is the in-memory adapter rather than PGlite, and the last case is
 * the exception that says why: a composed deployment, for the two facts only
 * composition can carry — that the slot is filled at all, and WITH WHAT env.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LanguageModel } from "ai";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import {
  type AppId,
  type ApprovalId,
  type FilesAdapter,
  type Principal,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { createApps, readBundleBlob, type AppsConfig } from "@vendoai/apps";
import { createGuard } from "@vendoai/guard";
import { createSessionRoutes } from "@vendoai/harnesses/box-door";
import { disposeSessionMachines, inferenceEnv } from "@vendoai/harnesses/claude-code/box";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { appBuilder, BUILD_ALLOWED_DOMAINS } from "../src/build-agent.js";
import { createVendo } from "../src/server.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const principal: Principal = { kind: "user", subject: "user_builder" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "session_builder" };

const APP = "app_build_lane" as AppId;
const ASK = "a photo editor that crops and rotates";
const WHY = "this needs a real image library";

const cleanups: Array<() => Promise<void>> = [];
const boxRoots: string[] = [];
afterEach(async () => {
  // The box pool is module-scoped: without this, one case's box is the next
  // case's thread-reuse.
  await disposeSessionMachines();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of boxRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env["VENDO_APP_BUILD_WATCHDOG_MS"];
});

/** One box, as a test can see it. */
interface Box {
  /** What the provider was asked to boot it with — the whole credential surface
   *  the box ever sees. */
  env: Record<string, string>;
  allowedDomains: readonly string[];
  /** Every brief the REAL session door opened a message with. */
  prompts: string[];
  destroyed: boolean;
  /** The provider reaping the machine with no notice, mid-build. */
  kill: () => void;
}

/** The in-box coding agent, scripted: handed the brief and the box's own disk
 *  root, it writes what a real one would write. */
type InBoxAgent = (input: { prompt: string; root: string; box: Box }) => void | Promise<void>;

interface ScriptedSandbox {
  boxes: Box[];
  create: (spec: unknown) => Promise<unknown>;
  destroy: () => Promise<void>;
}

/** A stand-in provider whose `request()` is a transport over the ACTUAL box
 *  session door, so the protocol under test is the real one. The same shape
 *  `tests/warm-spare.test.ts` proves the session path with. */
function scriptedSandbox(agent: InBoxAgent): ScriptedSandbox {
  const boxes: Box[] = [];
  return {
    boxes,
    async create(spec: unknown) {
      const { env, allowedDomains } = spec as { env: Record<string, string>; allowedDomains?: string[] };
      const root = mkdtempSync(join(tmpdir(), "vendo-build-box-"));
      boxRoots.push(root);
      let dead = false;
      const box: Box = {
        env: { ...env },
        allowedDomains: [...(allowedDomains ?? [])],
        prompts: [],
        destroyed: false,
        kill: () => { dead = true; },
      };
      boxes.push(box);
      const routes = createSessionRoutes({
        root,
        // Unclaimed, so the host's first `/session/hello` claims it.
        token: "",
        env: {},
        openSession: (input: { emit: (event: Record<string, unknown>) => void }) => ({
          async send(prompt: string) {
            box.prompts.push(prompt);
            await agent({ prompt, root, box });
            input.emit({ type: "text", delta: "done." });
          },
          async interrupt() { /* the turn stops; the session lives */ },
          async end() { /* the box is going away */ },
        }),
      }) as {
        handle: (method: string, pathname: string, headers: Record<string, string>, payload: unknown)
          => Promise<{ status: number; body: unknown }>;
      };
      return {
        id: `box_${boxes.length}`,
        async request(req: { method: string; path: string; headers?: Record<string, string>; body?: Uint8Array | string }) {
          if (dead) throw new Error("machine is gone");
          const payload = req.body === undefined
            ? {}
            : JSON.parse(typeof req.body === "string" ? req.body : decoder.decode(req.body)) as unknown;
          const answer = await routes.handle(req.method, req.path, req.headers ?? {}, payload);
          return { status: answer.status, headers: {}, body: encoder.encode(JSON.stringify(answer.body)) };
        },
        async destroy() { dead = true; box.destroyed = true; },
      };
    },
    async destroy() { /* no machine to reap by ref */ },
  };
}

/** What a working in-box agent leaves behind: a bundled entry, its source, and
 *  the lockfile of what it installed. */
const wrote = (root: string, appId: string, files: Record<string, string>): void => {
  for (const [path, text] of Object.entries(files)) {
    const disk = join(root, "user/apps", appId, path);
    mkdirSync(dirname(disk), { recursive: true });
    writeFileSync(disk, text);
  }
};

/** The appId out of the brief the box was handed — the lane mints none, it is
 *  the one the proposal carried. */
const appIdOf = (prompt: string): string => /\/user\/apps\/(app_[\w-]+)/u.exec(prompt)?.[1] ?? "";

/** A build whose in-box agent does its job. */
const buildsFine: InBoxAgent = ({ prompt, root }) => {
  wrote(root, appIdOf(prompt), {
    "dist/app.js": "console.log('cropped')",
    "src/index.ts": "export const crop = () => {};",
    "package-lock.json": "{}",
  });
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() {
    return { status: "error" as const, error: { code: "not-found", message: "no fixture tools" } };
  },
};

const memoryBlobs = (): FilesAdapter => {
  const bytes = new Map<string, Uint8Array>();
  return {
    async put(key, value) { bytes.set(key, value); },
    async get(key) { const found = bytes.get(key); return found === undefined ? undefined : { bytes: found }; },
    async delete(key) { bytes.delete(key); },
  };
};

const setup = (sandbox: ScriptedSandbox | undefined) => {
  const store = memoryStoreAdapter();
  const files = memoryBlobs();
  // The REAL guard: `decide` awaits its subscribers, which is the whole reason
  // the lane has to detach.
  const guard = createGuard({ store: memoryStoreAdapter(), policy: { rules: [] } });
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    files,
    // Composed exactly as `compose-apps.ts` composes it — the same `boxEnv`, so
    // what the box is handed here is what a deployment hands it.
    build: appBuilder({ sandbox: sandbox as never, boxEnv: inferenceEnv }),
  } as AppsConfig);
  const rowOf = async (appId: string): Promise<Record<string, unknown> | null> => {
    const record = await store.records("vendo_apps").get(appId);
    return record === null ? null : (record.data as { doc: Record<string, unknown> }).doc;
  };
  return { store, guard, files, runtime, rowOf };
};

type Harness = ReturnType<typeof setup>;

const propose = async ({ runtime }: Harness, prompt = ASK): Promise<ApprovalId> => {
  const outcome = await runtime.build.propose({ appId: APP, name: "Photo editor", prompt, why: WHY }, ctx);
  if (!("approvalId" in outcome)) throw new Error(`expected a card, got ${JSON.stringify(outcome)}`);
  return outcome.approvalId;
};

/** The person pressing Approve, through the guard the wire route drives. */
const decide = ({ guard }: Harness, approvalId: ApprovalId, approve = true): Promise<void> =>
  guard.approvals.decide(approvalId, { approve }, principal);

/** Poll the row until the detached lane has landed something terminal. */
const settled = async (harness: Harness): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const row = await harness.rowOf(APP);
    if (row !== null && row["building"] === undefined && row["proposal"] === undefined) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${APP} never settled`);
};

describe("a consented build runs the box and seals what it made", () => {
  it("boots one box, briefs it with the person's ask, and seals the bundle it collected", async () => {
    const sandbox = scriptedSandbox(buildsFine);
    const harness = setup(sandbox);

    const approvalId = await propose(harness);
    // Nothing spent yet: the card stands and no machine exists.
    expect(sandbox.boxes).toHaveLength(0);

    await decide(harness, approvalId);
    const row = await settled(harness);

    // ONE box, briefed with the person's own words and the escalation's reason.
    expect(sandbox.boxes).toHaveLength(1);
    const [box] = sandbox.boxes as [Box];
    expect(box.prompts).toHaveLength(1);
    expect(box.prompts[0]).toContain(ASK);
    expect(box.prompts[0]).toContain(WHY);

    // Sealed: the row is a bundle, and the entry hash reads back as the bytes
    // the box wrote — through the real seal and the real blob read.
    expect(row["ui"]).toBe("bundle");
    const bundle = row["bundle"] as { entry: string; assets: Record<string, string> };
    expect(await readBundleBlob(APP, bundle.entry, harness.files)).toEqual(encoder.encode("console.log('cropped')"));
    // The source and the lockfile came home beside it.
    expect(Object.keys(bundle.assets).sort()).toEqual(["package-lock.json", "src/index.ts"]);
    expect(row["buildFailed"]).toBeUndefined();
  });

  it("hands the box ZERO store credentials and only the registry to reach", async () => {
    const sandbox = scriptedSandbox(buildsFine);
    const harness = setup(sandbox);
    await decide(harness, await propose(harness));
    await settled(harness);

    const [box] = sandbox.boxes as [Box];
    // THE security invariant (FINAL SPEC v1): the box returns files, the host
    // seals them. Nothing that could reach this deployment's store, its wire or
    // its Cloud account is ever on that machine.
    for (const name of Object.keys(box.env)) {
      expect(name).not.toMatch(/VENDO_(STORE|HOST|APP_TOKEN|API_KEY|SECRET)/u);
      expect(name).not.toMatch(/DATABASE_URL|POSTGRES/u);
    }
    // …and no host tool door either: nothing in that box can act as anyone.
    expect(JSON.stringify(box.env)).not.toContain("/api/vendo");
    // Registry egress, for the build minute only.
    for (const domain of BUILD_ALLOWED_DOMAINS) expect(box.allowedDomains).toContain(domain);
  });

  it("leaves its box in the pool for the reaper rather than a second one", async () => {
    const sandbox = scriptedSandbox(buildsFine);
    const harness = setup(sandbox);
    await decide(harness, await propose(harness));
    await settled(harness);

    expect(sandbox.boxes).toHaveLength(1);
    // Not torn down inline and not leaked: the lane hands the box back to the
    // pool, which is what its idle timer (and the shutdown reap below) act on.
    // The wall-clock reap that `release()` arms is `boxMachine`'s own, proven
    // against a shortened TTL in `packages/harnesses/tests/claude-code`.
    expect(sandbox.boxes[0]!.destroyed).toBe(false);
    await disposeSessionMachines();
    expect(sandbox.boxes[0]!.destroyed).toBe(true);
  });
});

describe("approving comes straight back", () => {
  it("answers the decision while the build is still in the box", async () => {
    let started: () => void = () => undefined;
    const inTheBox = new Promise<void>((resolve) => { started = resolve; });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sandbox = scriptedSandbox(async (input) => {
      started();
      await held;
      buildsFine(input);
    });
    const harness = setup(sandbox);
    const approvalId = await propose(harness);

    const decided = decide(harness, approvalId);
    await inTheBox;
    // THE assertion: the guard AWAITS its decision subscribers, so this promise
    // settling while the box is still mid-build is the whole fix. Awaiting the
    // box inside the subscriber held `POST /approvals/decide` open — the person
    // pressed Approve and watched a request hang for the length of the build.
    await decided;
    expect(sandbox.boxes[0]!.prompts).toHaveLength(1);
    expect((await harness.rowOf(APP))?.["building"]).toEqual(expect.any(String));

    release();
    expect((await settled(harness))["ui"]).toBe("bundle");
  });
});

describe("every failure lands on the ONE terminal record", () => {
  const failsWith = (row: Record<string, unknown>, reason: RegExp): void => {
    expect(row["buildFailed"]).toMatchObject({ reason: expect.stringMatching(reason) });
    expect(row["building"]).toBeUndefined();
    expect(row["proposal"]).toBeUndefined();
    expect(row["ui"]).toBeUndefined();
  };

  it("no sandbox composed — the failure names the missing machine", async () => {
    const harness = setup(undefined);
    expect(harness.runtime.build.available()).toBe(false);

    await decide(harness, await propose(harness));

    failsWith(await settled(harness), /build machine/u);
  });

  it("the box dies mid-build", async () => {
    const sandbox = scriptedSandbox(({ box }) => { box.kill(); });
    const harness = setup(sandbox);

    await decide(harness, await propose(harness));

    failsWith(await settled(harness), /machine went away/u);
  });

  it("the agent's own test failed, so it left no entry behind", async () => {
    const sandbox = scriptedSandbox(({ prompt, root }) => {
      // Source, but no `dist/app.js` — the brief's way of saying the test failed.
      wrote(root, appIdOf(prompt), { "src/index.ts": "broken" });
    });
    const harness = setup(sandbox);

    await decide(harness, await propose(harness));

    failsWith(await settled(harness), /test did not pass/u);
  });

  it("the lane goes silent — the watchdog lands the record itself", async () => {
    process.env["VENDO_APP_BUILD_WATCHDOG_MS"] = "60";
    const sandbox = scriptedSandbox(async () => await new Promise(() => undefined));
    const harness = setup(sandbox);

    await decide(harness, await propose(harness));

    failsWith(await settled(harness), /never finished/u);
  });

  it("denying it opens no box at all", async () => {
    const sandbox = scriptedSandbox(buildsFine);
    const harness = setup(sandbox);

    await decide(harness, await propose(harness), false);

    failsWith(await settled(harness), /not approved/u);
    expect(sandbox.boxes).toHaveLength(0);
  });
});

describe("a failed RESEAL keeps the app it was rebuilding", () => {
  it("does not tombstone a row that already holds a sealed bundle", async () => {
    let works = true;
    const sandbox = scriptedSandbox((input) => { if (works) buildsFine(input); });
    const harness = setup(sandbox);
    await decide(harness, await propose(harness));
    const sealed = (await settled(harness))["bundle"] as { entry: string };

    // …and now the person asks for a change, and the rebuild fails.
    works = false;
    await decide(harness, await propose(harness, "make it dark"));
    const row = await settled(harness);

    // `markUnbuilt` would have REPLACED this row with a tombstone and taken a
    // working app with it. A reseal that failed loses only the build state.
    expect(row["ui"]).toBe("bundle");
    expect(row["bundle"]).toMatchObject({ entry: sealed.entry });
    expect(row["buildFailed"]).toBeUndefined();
    expect(row["building"]).toBeUndefined();
  });
});

describe("composition fills the slot", () => {
  const compose = async (sandbox: ScriptedSandbox | undefined) => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-build-lane-"));
    const store: VendoStore = createStore({ dataDir });
    cleanups.push(async () => {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const vendo = createVendo({
      // Never reached: nothing in this lane thinks on the host.
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store,
      ...(sandbox === undefined ? {} : { sandbox }),
    } as Parameters<typeof createVendo>[0]);
    await store.ensureSchema();
    return vendo;
  };

  it("a composed sandbox is the ONE gate, and the composed box holds no store credentials", async () => {
    expect((await compose(undefined)).apps.build.available()).toBe(false);

    let started: () => void = () => undefined;
    const inTheBox = new Promise<void>((resolve) => { started = resolve; });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sandbox = scriptedSandbox(async (input) => {
      started();
      await held;
      buildsFine(input);
    });
    const vendo = await compose(sandbox);
    expect(vendo.apps.build.available()).toBe(true);

    const proposed = await vendo.apps.build.propose(
      { appId: APP, name: "Photo editor", prompt: ASK, why: WHY }, ctx);
    if (!("approvalId" in proposed)) throw new Error("expected a card");
    await vendo.guard.approvals.decide(proposed.approvalId, { approve: true }, principal);
    await inTheBox;

    // What a REAL deployment put on the machine: the inference door and the
    // box's own handles, and not one thing that reaches this deployment's data.
    const [box] = sandbox.boxes as [Box];
    for (const name of Object.keys(box.env)) {
      expect(name).not.toMatch(/VENDO_(STORE|HOST|APP_TOKEN|API_KEY|SECRET)/u);
      expect(name).not.toMatch(/DATABASE_URL|POSTGRES/u);
    }
    release();
  });
});

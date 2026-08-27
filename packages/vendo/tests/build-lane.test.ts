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
  PARKED_BUILD_COLLECTION,
  type AppId,
  type ApprovalId,
  type FilesAdapter,
  type Principal,
  type RunContext,
  type StoreAdapter,
  type ToolRegistry,
} from "@vendoai/core";
import { createApps, readBundleBlob, type AppsConfig } from "@vendoai/apps";
import { BUILD_WATCHDOG_MS } from "@vendoai/apps/contract";
import { createGuard } from "@vendoai/guard";
import { MESSAGE_BUDGET_MS } from "@vendoai/harnesses/claude-code";
import { createSessionRoutes } from "@vendoai/harnesses/box-door";
import {
  BOX_WORKSPACE_ROOT,
  disposeSessionMachines,
  inferenceEnv,
} from "@vendoai/harnesses/claude-code/box";
import { createStore, type VendoStore } from "@vendoai/store";
import * as kit from "@vendoai/ui/kit";
import { afterEach, describe, expect, it } from "vitest";
import { appBuilder, BUILD_ALLOWED_DOMAINS, BUILD_STATUS_LINES } from "../src/build-agent.js";
import { createVendo } from "../src/server.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const principal: Principal = { kind: "user", subject: "user_builder" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "session_builder" };

const APP = "app_build_lane" as AppId;
/** Where the brief sends the box for the frame protocol. This file imports it,
 *  so a specifier that stopped resolving fails before any assertion runs. */
const KIT_SPECIFIER = "@vendoai/ui/kit";
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

/** The in-box coding agent, scripted: handed the brief and the box's WHOLE
 *  disk, it writes what a real one would write. It has a shell, not the host's
 *  workspace map, so it resolves the brief's paths against that disk. */
type InBoxAgent = (input: { prompt: string; disk: string; box: Box }) => void | Promise<void>;

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
      // The box's whole filesystem, with the host's workspace mounted where the
      // host itself said to mount it. Two paths, because the box has two: the
      // session door maps the host's workspace spellings onto `root`, while the
      // agent inside writes absolute paths onto `disk`.
      const disk = mkdtempSync(join(tmpdir(), "vendo-build-box-"));
      const root = join(disk, env["VENDO_WORKSPACE_ROOT"] ?? "");
      mkdirSync(root, { recursive: true });
      boxRoots.push(disk);
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
            await agent({ prompt, disk, box });
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

/**
 * What a working in-box agent leaves behind: a bundled entry, its source, and
 * the lockfile of what it installed — at the path the BRIEF named, resolved
 * against the box's own disk the way its shell resolves it.
 *
 * Not against the host's workspace map, which is the whole point: a brief that
 * spells a workspace path puts every write outside the mounted workspace, where
 * `collect` never looks. Measured live 2026-08-24 — 28 KB really bundled from
 * npm, `{"files":[]}` collected, every build reported as "its own test did not
 * pass".
 */
const wrote = (disk: string, prompt: string, files: Record<string, string>): void => {
  const directory = /^Build this for real, in (\S+)\.$/mu.exec(prompt)?.[1];
  if (directory === undefined) throw new Error(`the brief names no build directory:\n${prompt}`);
  for (const [path, text] of Object.entries(files)) {
    const target = join(disk, directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
};

/** A build whose in-box agent does its job. */
const buildsFine: InBoxAgent = ({ prompt, disk }) => {
  wrote(disk, prompt, {
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

const setup = (sandbox: ScriptedSandbox | undefined, store: StoreAdapter = memoryStoreAdapter()) => {
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
    // A SHELL reads this brief, so it must name the box's own disk path. The
    // host's workspace spelling puts every write outside the mounted workspace.
    expect(box.prompts[0]).toContain(`${BOX_WORKSPACE_ROOT}/user/apps/${APP}`);

    // Sealed: the row is a bundle, and the entry hash reads back as the bytes
    // the box wrote — through the real seal and the real blob read.
    expect(row["ui"]).toBe("bundle");
    const bundle = row["bundle"] as { entry: string; assets: Record<string, string> };
    expect(await readBundleBlob(APP, bundle.entry, harness.files)).toEqual(encoder.encode("console.log('cropped')"));
    // The source and the lockfile came home beside it.
    expect(Object.keys(bundle.assets).sort()).toEqual(["package-lock.json", "src/index.ts"]);
    expect(row["buildFailed"]).toBeUndefined();
  });

  it("briefs the box to speak the frame protocol the served shell and the host half define", async () => {
    // The seam this closes: the brief is the ONLY thing that tells the in-box
    // agent to mount where the shell mounts and to start the protocol the host
    // is already listening to. Both sides are read from the real thing — the
    // mount point off the document the door really serves, the two entry points
    // off the module the box really installs — so a rename on either side is a
    // red test and not a bundle that renders and then sits there.
    const sandbox = scriptedSandbox(buildsFine);
    const harness = setup(sandbox);
    await decide(harness, await propose(harness));
    const row = await settled(harness);

    const brief = sandbox.boxes[0]!.prompts[0] ?? "";
    const shell = decoder.decode(await harness.runtime.bundleDocument(
      APP, (row["bundle"] as { entry: string }).entry, ctx));
    const mountId = /id="([^"]+)"/u.exec(shell)?.[1] ?? "";
    expect(mountId).not.toBe("");
    expect(brief).toContain(mountId);

    for (const name of ["startFrameProtocol", "callHost"] as const) {
      expect(kit[name]).toBeTypeOf("function");
      expect(brief).toContain(name);
    }
    expect(brief).toContain(KIT_SPECIFIER);
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

describe("progress is chat status lines, and nothing more", () => {
  /** Poll the REAL pending answer until the lane has said something. The write
   *  is fire-and-forget by design, so it lands a beat after the label. */
  const labelled = async (harness: Harness): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const surface = await harness.runtime.open(APP, ctx, { pending: true }) as Record<string, unknown>;
      if (surface["status"] !== undefined) return surface;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the pending poll never carried a status");
  };

  const heldBox = () => {
    let started: () => void = () => undefined;
    const inTheBox = new Promise<void>((resolve) => { started = resolve; });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sandbox = scriptedSandbox(async (input) => {
      started();
      await held;
      buildsFine(input);
    });
    return { sandbox, inTheBox, release: () => release() };
  };

  it("the lane's own label reaches the pending poll, one line at a time", async () => {
    const { sandbox, inTheBox, release } = heldBox();
    const harness = setup(sandbox);

    await decide(harness, await propose(harness));
    await inTheBox;

    // THE SEAM. `BuildRequest.onStatus` shipped emitted and unread: the real
    // lane says these, the real row holds one, and the real pending answer —
    // the one the embed already polls — is what carries it out.
    const surface = await labelled(harness);
    // ONE LABEL FIELD, not a log: a scalar `status` and nothing beside it.
    expect(Object.keys(surface).sort()).toEqual(["kind", "status"]);
    // …and the words are the LANE'S OWN, read off the lane rather than copied
    // here: a rename there is a red test, never a build narrating a line
    // nobody writes any more. Either of them, because the two writes are
    // deliberately independent (build-door.ts) and race by design.
    expect(BUILD_STATUS_LINES as readonly string[]).toContain(surface["status"]);

    release();
    // A label is build state, not app content: the seal takes it with the rest.
    expect((await settled(harness))["buildStatus"]).toBeUndefined();
  });

  it("a status write the store refuses still leaves the build succeeding", async () => {
    // Progress is cosmetic; the build is not. Only the status write is refused
    // — the same row's own writes go through, so what is on trial is the
    // failure of THIS write and nothing else.
    const backing = memoryStoreAdapter();
    let refused = 0;
    const refusesLabels: StoreAdapter = {
      ...backing,
      records: (collection) => {
        const records = backing.records(collection);
        // The label write is the ONLY one refused, and it is told apart by the
        // field it carries — so the row's own writes (`building`, the seal) land
        // exactly as they always do.
        if (collection !== "vendo_apps" || records.atomic === undefined) return records;
        const atomic = records.atomic;
        return {
          ...records,
          atomic: {
            ...atomic,
            compareAndSwap: async (input, revision) => {
              if ((input.data as { doc?: { buildStatus?: unknown } }).doc?.buildStatus === undefined) {
                return await atomic.compareAndSwap(input, revision);
              }
              refused += 1;
              throw new Error("the store refused this write");
            },
          },
        };
      },
    };
    const { sandbox, inTheBox, release } = heldBox();
    const harness = setup(sandbox, refusesLabels);

    await decide(harness, await propose(harness));
    // Held in the box, so the labels are written while the build is still
    // running — a build that has already sealed writes no label at all, and
    // this case would then pass on a lane that never tried.
    await inTheBox;
    for (let attempt = 0; refused === 0 && attempt < 400; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(refused).toBeGreaterThan(0);

    release();
    const row = await settled(harness);
    expect(row["ui"]).toBe("bundle");
    expect(row["buildFailed"]).toBeUndefined();
    expect(row["buildStatus"]).toBeUndefined();
  });
});

describe("every failure lands on the ONE terminal record", () => {
  const failsWith = (row: Record<string, unknown>, reason: RegExp): void => {
    expect(row["buildFailed"]).toMatchObject({ reason: expect.stringMatching(reason) });
    expect(row["building"]).toBeUndefined();
    expect(row["proposal"]).toBeUndefined();
    expect(row["ui"]).toBeUndefined();
    // A failure loses the BUILD, never the app: the tombstone used to replace
    // the row wholesale and rename the person's app to a cut of their prompt,
    // which then rode into the version history.
    expect(row["name"]).toBe("Photo editor");
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
    const sandbox = scriptedSandbox(({ prompt, disk }) => {
      // Source, but no `dist/app.js` — the brief's way of saying the test failed.
      wrote(disk, prompt, { "src/index.ts": "broken" });
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

describe("the dead-man timer outlasts the work it guards", () => {
  it("gives a build longer than the box's own message budget", () => {
    // The two numbers only meet HERE — `@vendoai/apps` cannot see the box, and
    // the box cannot see the watchdog. At 4 minutes the watchdog always won:
    // three real builds (229 s, 414 s, 450 s) were killed mid-work on
    // 2026-08-24, and the box will not even give up on one message for 15.
    expect(BUILD_WATCHDOG_MS).toBeGreaterThan(MESSAGE_BUDGET_MS);
  });
});

describe("a propose that cannot finish leaves no card standing", () => {
  it("takes the ask back when the parked record cannot be written", async () => {
    // What the real Cloud store did on 2026-08-24: its engine allowlist is a
    // version behind, so `vendo_parked_build` was refused — AFTER the guard had
    // already parked the card. Two orphan asks were left standing in a real
    // person's feed with no build behind either of them.
    const backing = memoryStoreAdapter();
    const store: StoreAdapter = {
      ...backing,
      records: (collection) => collection !== PARKED_BUILD_COLLECTION
        ? backing.records(collection)
        : {
          ...backing.records(collection),
          put: () => Promise.reject(new Error(`collection "${collection}" is not an engine collection`)),
        },
    };
    const harness = setup(scriptedSandbox(buildsFine), store);

    await expect(harness.runtime.build.propose(
      { appId: APP, name: "Photo editor", prompt: ASK, why: WHY }, ctx,
    )).rejects.toThrow(/engine collection/u);

    expect(await harness.guard.approvals.pending(principal)).toEqual([]);
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

  it("an app that is only OFFERED reads as pending on the wire, never as gone", async () => {
    const vendo = await compose(scriptedSandbox(buildsFine));
    const proposed = await vendo.apps.build.propose(
      { appId: APP, name: "Photo editor", prompt: ASK, why: WHY }, ctx);
    if (!("approvalId" in proposed)) throw new Error("expected a card");

    // The exact request the embed makes while the card stands. It answered
    // "This app can't be opened any more — create it again to replace it." to a
    // person who had just been asked whether to build it (measured live
    // 2026-08-24, on all three propose runs).
    const answer = await vendo.handler(new Request(
      `https://host.test/api/vendo/apps/${APP}/open?pending=1`));

    expect(await answer.json()).toEqual({ kind: "pending" });
  });

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

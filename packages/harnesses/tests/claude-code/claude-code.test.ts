import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  VENDO_MAKE_TOOL,
  VendoError,
  type HarnessEvent,
  type Json,
  type ToolResult,
  type Turn,
} from "@vendoai/core";
import { afterEach, describe, expect, test, vi } from "vitest";
// The REAL box door, driven over a fake transport — see the block comment below.
// A package subpath, not a relative climb: the door is the wire contract between
// these two blocks, and `harnesses → apps` is a layer-legal edge.
import { createSessionRoutes } from "@vendoai/apps/box-door";
import { assertHarnessComposable } from "../../src/compose.js";
import { createTurnState } from "../../src/harness-state.js";
import { provideHarnessAdapters } from "../../src/harness-sandbox.js";
import { testWorkspace, unusedModels, userMessage } from "../../src/test-doubles.test-util.js";
import { boxEgress, claudeCode, inferenceEnv, promptFor, truncated } from "../../src/claude-code/index.js";
import { boxMachine, disposeSessionMachines, type SandboxAdapterLike, type SandboxMachineLike } from "../../src/claude-code/box.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * A stand-in for a REAL box: it speaks the same control-port wire the machine
 * image speaks (`packages/apps/box/turn-routes.mjs`), so what is under test is
 * our driver and our sync-back — never a mock of our own code. The SDK loop is
 * the one thing scripted, because a unit test cannot run a model.
 */
/**
 * A stand-in for a real box that speaks the REAL protocol: the fake machine's
 * `request()` is a thin transport adapter over the ACTUAL box door
 * (`packages/apps/box/turn-routes.mjs`), with only the SDK session scripted.
 *
 * A hand-written fake let a live BLOCKER hide: it accepted `hello`
 * unconditionally, so it modelled a protocol the real box does not implement.
 * Driving the real door means that class cannot come back.
 *
 * One provider behaviour is modelled deliberately because it is load bearing: a
 * CREATED machine boots with NO token, since create-time envs never reach a
 * template's start command. There is no resumed-machine case any more — a
 * conversation box is destroyed rather than snapshotted.
 */
type BoxScript = (box: {
  /** The host's MCP door and this conversation's credential, as they reached the
   *  session. Where a projected `callTool` port used to be: the box now speaks to
   *  the door itself, so what the driver HANDS it is the whole of the contract. */
  toolDoor?: { url: string; token: string };
  emit: (event: Record<string, unknown>) => void;
  /** What the box was told to think with — `Turn.system` plus the workspace
   *  brief, as it arrives through the real door. */
  systemPrompt?: string;
  /** Writes even over a read-only `/host` bind — the box's chmod is advisory, so
   *  an agent that defeats it is exactly the case the sync-back seam must catch. */
  write: (workspacePath: string, text: string) => void;
  read: (workspacePath: string) => string | undefined;
  /** The provider reaping the machine mid-turn. A script that merely THROWS is a
   *  failing thinker, which is a different fact. */
  kill: () => void;
  /** The native session the harness asked this session to continue, if any. */
  resume?: string;
  /** What the user's message actually looked like by the time it reached the SDK —
   *  either just what they said, or the full re-seed from OUR transcript. */
  prompt?: string;
}) => Promise<void>;

interface FakeBox extends SandboxMachineLike {
  /** The materialized workspace on this machine's disk. */
  root: string;
  destroyed: boolean;
  /** How many messages this box's live session has answered. */
  messages: number;
  /** ⚠️ TEST EDIT — every word the live session was STEERED with, in order.
   *  The real session pushes these into its open SDK input stream; this is the
   *  only place a test can see that they arrived. */
  steers: string[];
  /** ⚠️ TEST EDIT — did the live session get INTERRUPTED? Stop reaches it
   *  through the door, so this is where the whole chain becomes observable. */
  interrupted: boolean;
  env: Record<string, string>;
}

const boxRoots: string[] = [];
afterEach(() => {
  for (const root of boxRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const diskPath = (root: string, workspacePath: string): string =>
  path.join(root, workspacePath.replace(/^\/+/, ""));

type CreateSpec = { template?: string; env: Record<string, string>; allowedDomains?: string[] };

function fakeSandbox(script: BoxScript): SandboxAdapterLike & { boxes: FakeBox[]; specs: CreateSpec[] } {
  const adapter = {
    boxes: [] as FakeBox[],
    /** Every create SPEC, verbatim. The network policy is a create-time argument
     *  and nothing observable inside the box reflects it, so the spec is the only
     *  place the allowlist can be seen. */
    specs: [] as CreateSpec[],
    async create(spec: CreateSpec) {
      adapter.specs.push(spec);
      return makeBox(adapter, script, spec.env);
    },
    async destroy() { /* teardown by ref; nothing to do here */ },
  };
  return adapter;
}

function makeBox(
  adapter: { boxes: FakeBox[] },
  script: BoxScript,
  env: Record<string, string>,
): FakeBox {
  const root = mkdtempSync(path.join(tmpdir(), "vendo-fakebox-"));
  boxRoots.push(root);

  const box = {
    id: `box_${adapter.boxes.length}`,
    root,
    env,
    destroyed: false,
    messages: 0,
    steers: [],
    interrupted: false,
  } as unknown as FakeBox;
  /** Is the doubled session inside a `send()` right now? */
  let inFlight = false;

  const routes = createSessionRoutes({
    root,
    // A CREATED machine boots with NO token: the provider does not hand
    // create-time envs to a template's start command, so the first hello claims it.
    token: "",
    env: {},
    /** The live session. Opened once per box; `send()` plays the script. */
    openSession: (input: {
      emit: (event: Record<string, unknown>) => void;
      onFileWritten?: (path: string | undefined) => void;
      resume?: string;
      systemPrompt?: string;
      toolDoor?: { url: string; token: string };
    }) => ({
      // ⚠️ TEST EDIT — the double speaks the whole `ClaudeSession` port now that
      // `steer` joined it, and mirrors the real session's refusal when no turn is
      // in flight (there would be nobody for the extra `result` to settle).
      steer(prompt: string) {
        if (box.messages === 0 || inFlight === false) return false;
        box.steers.push(prompt);
        return true;
      },
      async send(prompt: string) {
        box.messages += 1;
        inFlight = true;
        try {
          await script({
          prompt,
          ...(input.toolDoor === undefined ? {} : { toolDoor: input.toolDoor }),
          emit: input.emit,
          ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
          write: (workspacePath, text) => {
            const target = diskPath(root, workspacePath);
            mkdirSync(path.dirname(target), { recursive: true });
            try {
              chmodSync(target, 0o644);
            } catch {
              // Not there yet, or already writable.
            }
            writeFileSync(target, text);
            // The real SDK's PostToolUse hook fires on every write; the fake must
            // too, or the hot-path sync has nothing to react to.
            input.onFileWritten?.(target);
          },
          kill: () => { box.destroyed = true; },
          read: (workspacePath) => {
            try {
              return readFileSync(diskPath(root, workspacePath), "utf8");
            } catch {
              return undefined;
            }
          },
            ...(input.resume === undefined ? {} : { resume: input.resume }),
          });
        } finally {
          inFlight = false;
        }
      },
      async interrupt() {
        // ⚠️ TEST EDIT — the turn is cut short; the session lives.
        box.interrupted = true;
      },
      async end() { /* the box is going away */ },
    }),
  }) as {
    handle: (method: string, pathname: string, headers: Record<string, string>, payload: unknown)
      => Promise<{ status: number; body: unknown }>;
  };

  box.destroy = async () => { box.destroyed = true; };
  // ⚠️ TEST EDIT — the widened `SandboxMachineLike` requires it. Shaped like
  // e2b's per-port public hostname (`https://<host-for-port>`), which is the
  // provider behaviour the shared adapter conformance suite certifies.
  box.url = async (port?: number) => `https://${box.id}-${port ?? 8080}.fake-provider.test`;
  box.request = async (req) => {
    if (box.destroyed) throw new VendoError("not-found", "machine is gone");
    const payload = req.body === undefined
      ? {}
      : JSON.parse(typeof req.body === "string" ? req.body : decoder.decode(req.body)) as Record<string, unknown>;
    const answer = await routes.handle(req.method, req.path, (req.headers ?? {}) as Record<string, string>, payload);
    return { status: answer.status, headers: {}, body: encoder.encode(JSON.stringify(answer.body)) };
  };

  adapter.boxes.push(box);
  return box;
}

let threadSeq = 0;

afterEach(async () => { await disposeSessionMachines(); });

interface TurnDouble {
  turn: Turn<never>;
  workspace: ReturnType<typeof testWorkspace>;
  calls: Array<{ name: string; args: Json }>;
  state: ReturnType<typeof createTurnState>;
}

function makeTurn(input: {
  files?: Record<string, string>;
  /** ONE store across several turns — what a real conversation has, and the only
   *  way an out-of-band write between turns is expressible. */
  workspace?: ReturnType<typeof testWorkspace>;
  tools?: Array<{ name: string; title: string; description: string }>;
  answer?: (name: string, args: Json) => ToolResult;
  state?: string;
  /** The pool keys on the first message's id, so a test that wants the SAME
   *  session across two turns names it. */
  thread?: string;
  /** `Turn.threadId` — the pool's FIRST key (contract amendment ccaba80a7).
   *  Tests that omit it exercise the untyped-caller fallback above. */
  threadId?: string;
  messages?: Array<{ id: string; text: string }>;
  skills?: Array<{ name: string; description: string }>;
} = {}): TurnDouble {
  const workspace = input.workspace ?? testWorkspace(input.files ?? {});
  const calls: Array<{ name: string; args: Json }> = [];
  const state = createTurnState(input.state);
  const messages = (input.messages ?? [{ id: input.thread ?? `m_${(threadSeq += 1)}`, text: "make me a dashboard" }])
    .map((m) => userMessage(m.id, m.text));
  const turn = {
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    messages,
    tools: {
      list: async () => (input.tools ?? [{ name: "maple_invoices_list", title: "List invoices", description: "d" }])
        .map((t) => ({ ...t, risk: "read" as const })),
      call: async (name: string, args: Json) => {
        calls.push({ name, args });
        return input.answer?.(name, args) ?? { status: "ok" as const, output: { ok: true } };
      },
    },
    skills: { list: async () => input.skills ?? [], load: async () => "" },
    workspace,
    models: unusedModels(),
    state,
    options: {} as never,
    signal: new AbortController().signal,
    interactive: true,
    system: "PRODUCT BRIEF",
  } as unknown as Turn<never>;
  return { turn, workspace, calls, state };
}

const drain = async (harness: ReturnType<typeof claudeCode>, turn: Turn<never>): Promise<HarnessEvent[]> => {
  const events: HarnessEvent[] = [];
  for await (const event of harness.run(turn as never)) events.push(event);
  return events;
};

/** Pin the process env for one body — `inferenceEnv()` reads it, and so does the
 *  egress allowlist derived from it. */
const withEnv = <T>(vars: Record<string, string | undefined>, body: () => T): T => {
  const source = process.env as Record<string, string | undefined>;
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, source[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete source[key];
    else source[key] = value;
  }
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete source[key];
      else source[key] = value;
    }
  }
};

/** The same, for a body that AWAITS: `withEnv`'s synchronous `finally` would put
 *  the real environment back the moment the body returned its promise — before
 *  the work under test ever read the pinned one. */
const withEnvAsync = async (
  vars: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> => {
  const source = process.env as Record<string, string | undefined>;
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, source[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete source[key];
    else source[key] = value;
  }
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete source[key];
      else source[key] = value;
    }
  }
};

describe("the boot gate — a spawned harness with no machine to live on (design §9)", () => {
  test("FAILS closed: claudeCode() with no sandbox adapter is a boot error", () => {
    expect(() => assertHarnessComposable(claudeCode() as never, {})).toThrow(VendoError);
    expect(() => assertHarnessComposable(claudeCode() as never, {})).toThrow(/needs a sandbox adapter/);
  });

  test("passes with an adapter composed", () => {
    expect(() => assertHarnessComposable(claudeCode() as never, { sandbox: {} })).not.toThrow();
  });

  test("machine:\"local\" is the explicit opt-in that needs no machine", () => {
    expect(() => assertHarnessComposable(claudeCode({ machine: "local" }) as never, {})).not.toThrow();
    expect(claudeCode({ machine: "local" }).requires?.sandbox).toBeUndefined();
  });

  test("the harness names itself exactly what the compose fixture expects", () => {
    expect(claudeCode().name).toBe("claude-code");
  });

  test("BOTH legs declare `requires.toolDoor` — the ask that makes composition mount a door", () => {
    // The tools travel remote MCP whether the SDK runs in a box or as a
    // subprocess here, so both legs need the door. Declaring it is the whole
    // ask: `createVendo` mounts the internal-only half with no `mcp` option,
    // which is why `harness: claudeCode()` needs no extra config at all. Unlike
    // `sandbox` this can never be a boot error — composition always answers.
    expect(claudeCode().requires?.toolDoor).toBe(true);
    expect(claudeCode({ machine: "local" }).requires?.toolDoor).toBe(true);
    expect(() => assertHarnessComposable(claudeCode({ machine: "local" }) as never, {})).not.toThrow();
  });
});

describe("the tool surface it asks for (design §D2/§D4)", () => {
  test("uncurated, with app generation withheld", () => {
    // Exact, not `toMatchObject`: an extra withheld name is a capability this
    // harness silently lost, and the loadout coming back is the friction §D2
    // removed. Both legs declare it — the surface is the harness's, not the
    // machine's. ONE name now covers both generation paths, so a second entry
    // creeping back in means a door reopened that this harness closed.
    for (const harness of [claudeCode(), claudeCode({ machine: "local" })]) {
      expect(harness.toolSurface).toEqual({
        curated: false,
        withhold: [VENDO_MAKE_TOOL],
      });
    }
  });
});

describe("options — declared, then overridable per turn", () => {
  test("only `maxTurns` is per-turn overridable — model and effort are construction-time (agents spec 2026-08-04 cut)", () => {
    const shape = (claudeCode().optionsSchema as never as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape).sort()).toEqual(["maxTurns"]);
  });

  test("m1 · `machine` is construction-time only — a per-turn option cannot move the SDK onto the host", async () => {
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "boxed" }); });
    const { turn } = makeTurn();
    // A wire caller smuggling the deployment knob into a request.
    (turn as unknown as { options: unknown }).options = { machine: "local" };
    expect(await drain(claudeCode({ sandbox }), turn)).toContainEqual({ type: "text", delta: "boxed" });
    // A box was still used: the SDK never came near the host's own server.
    expect(sandbox.boxes).toHaveLength(1);
  });
});

describe("E7 · the credential law — build list item 8", () => {
  test("only the recorded v0 inference exception enters the machine", () => {
    const env = withEnv({
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: "https://gateway.example/v1/",
      E2B_API_KEY: "e2b-should-never-travel",
      DATABASE_URL: "postgres://should-never-travel",
      VENDO_API_KEY: "vnd-should-never-travel",
    }, inferenceEnv);
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "sk-test",
      // The bare origin: the SDK wants no /v1 and no trailing slash.
      ANTHROPIC_BASE_URL: "https://gateway.example",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    });
  });

  test("the box's own VENDO_INFERENCE_* wiring is the same one exception", () => {
    const env = withEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      VENDO_INFERENCE_KEY: "gw-key",
      VENDO_INFERENCE_URL: "https://console.vendo.run/api/v1",
    }, inferenceEnv);
    expect(env["ANTHROPIC_API_KEY"]).toBe("gw-key");
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://console.vendo.run/api");
  });

  test("no inference credential at all still yields no OTHER credential", () => {
    const env = withEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      VENDO_INFERENCE_KEY: undefined,
      VENDO_INFERENCE_URL: undefined,
      VENDO_API_KEY: undefined,
      E2B_API_KEY: "e2b-should-never-travel",
    }, inferenceEnv);
    expect(Object.keys(env).sort()).toEqual([
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "DISABLE_AUTOUPDATER",
    ]);
  });

  test("VENDO_API_KEY is the third rung — the box thinks through the Vendo Cloud gateway", () => {
    const env = withEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      VENDO_INFERENCE_KEY: undefined,
      VENDO_INFERENCE_URL: undefined,
      VENDO_API_KEY: "vnd-key",
      VENDO_CLOUD_URL: undefined,
    }, inferenceEnv);
    expect(env["ANTHROPIC_API_KEY"]).toBe("vnd-key");
    // `<console>/api/v1`, through the same trim as every other rung's URL: the
    // SDK re-appends the /v1.
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://console.vendo.run/api");
    // The gateway serves the vendo model FAMILY as literal ids and would
    // grace-remap the SDK's raw claude-* default, so the default is pinned —
    // env only, which an explicit `options.model` on the session payload beats.
    expect(env["ANTHROPIC_MODEL"]).toBe("vendo");
  });

  test("VENDO_CLOUD_URL overrides the console base on the Cloud rung", () => {
    const env = withEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      VENDO_INFERENCE_KEY: undefined,
      VENDO_INFERENCE_URL: undefined,
      VENDO_API_KEY: "vnd-key",
      VENDO_CLOUD_URL: "https://cloud.example/",
    }, inferenceEnv);
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://cloud.example/api");
  });

  test("the Cloud rung yields to every higher rung — and an empty string counts as absent", () => {
    // An explicit Anthropic key wins; no gateway pin rides along.
    const anthropic = withEnv({
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: undefined,
      VENDO_INFERENCE_KEY: undefined,
      VENDO_INFERENCE_URL: undefined,
      VENDO_API_KEY: "vnd-key",
    }, inferenceEnv);
    expect(anthropic["ANTHROPIC_API_KEY"]).toBe("sk-test");
    expect(anthropic["ANTHROPIC_MODEL"]).toBeUndefined();

    // So does a pre-resolved VENDO_INFERENCE_* gateway.
    const preResolved = withEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      VENDO_INFERENCE_KEY: "gw-key",
      VENDO_INFERENCE_URL: "https://console.vendo.run/api/v1",
      VENDO_API_KEY: "vnd-key",
    }, inferenceEnv);
    expect(preResolved["ANTHROPIC_API_KEY"]).toBe("gw-key");
    expect(preResolved["ANTHROPIC_MODEL"]).toBeUndefined();

    // A bare BYO endpoint (URL, no key — mTLS/proxy auth) is an own credential
    // too: routing it through Vendo's gateway would silently rebill the org.
    const byoEndpoint = withEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: "https://gateway.example",
      VENDO_INFERENCE_KEY: undefined,
      VENDO_INFERENCE_URL: undefined,
      VENDO_API_KEY: "vnd-key",
    }, inferenceEnv);
    expect(byoEndpoint["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(byoEndpoint["ANTHROPIC_MODEL"]).toBeUndefined();
    expect(byoEndpoint["ANTHROPIC_BASE_URL"]).toBe("https://gateway.example");

    // "" is absent, exactly as the higher rungs already treat it.
    const blanks = withEnv({
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: "",
      VENDO_INFERENCE_KEY: "",
      VENDO_INFERENCE_URL: "",
      VENDO_API_KEY: "vnd-key",
      VENDO_CLOUD_URL: "",
    }, inferenceEnv);
    expect(blanks["ANTHROPIC_API_KEY"]).toBe("vnd-key");
    expect(blanks["ANTHROPIC_BASE_URL"]).toBe("https://console.vendo.run/api");
    expect(blanks["ANTHROPIC_MODEL"]).toBe("vendo");
  });
});

// These pin WHAT WE SEND the provider, which is all this repo controls. How
// strongly the provider then enforces it is a separate question with a real
// gap: docs/verification/box-egress/README.md.
describe("the box's egress allowlist — what the provider is asked to filter", () => {
  /** The env a box gets when nothing about inference is configured on the host. */
  const NO_INFERENCE = {
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_BASE_URL: undefined,
    VENDO_INFERENCE_KEY: undefined,
    VENDO_INFERENCE_URL: undefined,
    VENDO_API_KEY: undefined,
  };
  const DOOR = "https://app.example.com/api/vendo/mcp";

  test("the minimum set is the inference host and the door origin — assembled from what the box is actually given", () => {
    expect(boxEgress({ ANTHROPIC_BASE_URL: "https://gateway.example" }, DOOR))
      .toEqual(["gateway.example", "app.example.com"]);
  });

  test("no configured base URL means the SDK's own default host, and nothing else", () => {
    expect(boxEgress({}, undefined)).toEqual(["api.anthropic.com"]);
  });

  test("a host's declared domains ADD to the minimum — normalized and deduped, never replacing it", () => {
    expect(boxEgress({}, DOOR, [" API.Stripe.COM ", "app.example.com", ""]))
      .toEqual(["api.anthropic.com", "app.example.com", "api.stripe.com"]);
  });

  test("a conversational box is provisioned WITH an allowlist — undefined would be unrestricted internet", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    const harness = claudeCode({ sandbox });
    provideHarnessAdapters(harness, {
      toolDoor: { url: DOOR, mint: () => "vtk_1", revoke: () => undefined },
    });
    await withEnvAsync(NO_INFERENCE, async () => {
      await drain(harness, makeTurn({ threadId: "thr_egress_min" }).turn);
    });
    expect(sandbox.specs).toHaveLength(1);
    // EXACT, not "contains": an extra entry here is an extra hole in the box.
    expect(sandbox.specs[0]?.allowedDomains).toEqual(["api.anthropic.com", "app.example.com"]);
  });

  test("with no door composed the box still gets an allowlist — the inference host alone", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    await withEnvAsync(NO_INFERENCE, async () => {
      await drain(claudeCode({ sandbox }), makeTurn({ threadId: "thr_egress_nodoor" }).turn);
    });
    expect(sandbox.specs[0]?.allowedDomains).toEqual(["api.anthropic.com"]);
  });

  test("the HOST may widen it — one additive option on the constructor", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    const harness = claudeCode({ sandbox, egress: ["api.stripe.com"] });
    provideHarnessAdapters(harness, {
      toolDoor: { url: DOOR, mint: () => "vtk_2", revoke: () => undefined },
    });
    await withEnvAsync(NO_INFERENCE, async () => {
      await drain(harness, makeTurn({ threadId: "thr_egress_widen" }).turn);
    });
    expect(sandbox.specs[0]?.allowedDomains)
      .toEqual(["api.anthropic.com", "app.example.com", "api.stripe.com"]);
  });

  test("`egress` is construction-time only — a wire caller cannot widen the box's network boundary", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    const { turn } = makeTurn({ threadId: "thr_egress_smuggle" });
    // A request smuggling the deployment's network policy into a per-turn option.
    (turn as unknown as { options: unknown }).options = { egress: ["evil.example.net"] };
    await withEnvAsync(NO_INFERENCE, async () => { await drain(claudeCode({ sandbox }), turn); });
    expect(sandbox.specs[0]?.allowedDomains).toEqual(["api.anthropic.com"]);
  });

  test("the Cloud rung's gateway host rides the allowlist, read off the env the box is handed", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    const harness = claudeCode({ sandbox });
    provideHarnessAdapters(harness, {
      toolDoor: { url: DOOR, mint: () => "vtk_3", revoke: () => undefined },
    });
    await withEnvAsync({ ...NO_INFERENCE, VENDO_API_KEY: "vnd-key", VENDO_CLOUD_URL: undefined }, async () => {
      await drain(harness, makeTurn({ threadId: "thr_egress_cloud" }).turn);
    });
    // The gateway host and the door — NOT api.anthropic.com, which this box
    // never dials.
    expect(sandbox.specs[0]?.allowedDomains).toEqual(["console.vendo.run", "app.example.com"]);
  });
});

describe("`template` — which image the conversation box boots from", () => {
  test("construction-time option reaches sandbox.create", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    await withEnvAsync({ VENDO_BOX_TEMPLATE: undefined }, async () => {
      await drain(claudeCode({ sandbox, template: "tpl_convo" }), makeTurn({ threadId: "thr_template" }).turn);
    });
    expect(sandbox.specs[0]?.template).toBe("tpl_convo");
  });

  test("unset falls back to VENDO_BOX_TEMPLATE, like every box", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    await withEnvAsync({ VENDO_BOX_TEMPLATE: "tpl_env" }, async () => {
      await drain(claudeCode({ sandbox }), makeTurn({ threadId: "thr_template_env" }).turn);
    });
    expect(sandbox.specs[0]?.template).toBe("tpl_env");
  });
});

describe("promptFor — the truth is ours", () => {
  test("a resumed session is asked only what the user just said", () => {
    const messages = [userMessage("m1", "first"), userMessage("m2", "second")];
    expect(promptFor(messages, true)).toBe("second");
  });

  test("a fresh session — a swap mid-conversation — is re-seeded from OUR transcript", () => {
    const messages = [userMessage("m1", "make a dashboard"), userMessage("m2", "now make it blue")];
    const prompt = promptFor(messages, false);
    expect(prompt).toContain("make a dashboard");
    expect(prompt).toContain("now make it blue");
  });
});

describe("one box per conversation, destroyed when it goes idle (design §9)", () => {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  test("an idle box is DESTROYED, not snapshotted — there is no resume ref to keep", async () => {
    // The snapshot existed to make a woken session resumable. A live session has
    // no cold start to optimise away, so the box simply goes, and the store plus
    // our transcript are what the next message recovers from.
    const sandbox = fakeSandbox(async () => undefined);
    const first = await boxMachine({ sandbox, threadId: "thr_idle", env: {}, allowedDomains: [], idleTtlMs: 5 });
    await first.release();
    await wait(60);

    expect(sandbox.boxes[0]?.destroyed).toBe(true);
    // Nothing on the adapter was ever asked to snapshot or resume: the whole
    // mechanism is gone, not merely unused.
    expect("snapshot" in sandbox.boxes[0]!).toBe(false);
    expect("resume" in sandbox).toBe(false);
  });

  test("a box whose conversation is mid-message is NOT destroyed", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    await boxMachine({ sandbox, threadId: "thr_busy", env: {}, allowedDomains: [], idleTtlMs: 5 });
    // Never released: the message is still running.
    await wait(60);
    expect(sandbox.boxes[0]?.destroyed).toBe(false);
  });

  test("a WARM box carries the conversation, so the next message neither re-materializes nor re-seeds", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    const first = await boxMachine({ sandbox, threadId: "thr_warm", env: {}, allowedDomains: [], idleTtlMs: 5_000 });
    // A box only becomes warm once it has answered a message.
    expect(first.carriesSession).toBe(false);
    await first.send({ prompt: "hi", emit: () => undefined });
    await first.release();

    const second = await boxMachine({ sandbox, threadId: "thr_warm", env: {}, allowedDomains: [] });
    expect(second.carriesSession).toBe(true);
    expect(sandbox.boxes).toHaveLength(1);
  });

  test("a box the provider reaped is replaced, and the replacement says it carries nothing", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    const first = await boxMachine({ sandbox, threadId: "thr_reaped", env: {}, allowedDomains: [], idleTtlMs: 5_000 });
    await first.send({ prompt: "hi", emit: () => undefined });
    await first.release();
    // Gone without us asking — a provider reap, an idle policy on their side.
    sandbox.boxes[0]!.destroyed = true;

    const second = await boxMachine({ sandbox, threadId: "thr_reaped", env: {}, allowedDomains: [] });
    // The harness must re-materialize and re-seed rather than resume a session
    // no disk holds, and `carriesSession: false` is what tells it to.
    expect(second.carriesSession).toBe(false);
    expect(sandbox.boxes).toHaveLength(2);
  });

  test("m4 · the box map keys on turn.threadId when the runtime supplies one", async () => {
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "hi" }); });
    const harness = claudeCode({ sandbox });
    for (const messageId of ["m_a", "m_b"]) {
      const { turn } = makeTurn({ thread: messageId });
      // Two different first messages, ONE conversation.
      (turn as unknown as { threadId: string }).threadId = "thr_named";
      await drain(harness, turn);
    }
    expect(sandbox.boxes).toHaveLength(1);
  });

  test("m4 · two threads with NO identity never share a machine, a session, or a workspace", async () => {
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "hi" }); });
    const harness = claudeCode({ sandbox });
    for (let index = 0; index < 2; index += 1) {
      const { turn } = makeTurn();
      (turn as unknown as { messages: unknown[] }).messages = [];
      await drain(harness, turn);
    }
    expect(sandbox.boxes).toHaveLength(2);
  });

  test("§1.4 · a box IS now held while a guarded call waits — the wait moved to the door", async () => {
    // RECORDED, not celebrated. The approval wait used to happen in THIS driver,
    // which armed the idle timer across it so a wait outliving the idle budget
    // lost the box (and losing it mid-turn is a case the store survives). It now
    // happens inside the door, on the host, and from out here it is
    // indistinguishable from a slow tool — so the box survives the whole window,
    // bounded by MESSAGE_BUDGET_MS. Better for the user (an approved call
    // resumes on the same session), worse for cost. The lane's close note calls
    // it out as a deviation; this test is what stops it being invisible.
    const sandbox = fakeSandbox(async () => undefined);
    const machine = await boxMachine({ sandbox, threadId: "thr_lease", env: {}, allowedDomains: [], idleTtlMs: 20 });
    const box = sandbox.boxes[0]!;
    const request = box.request.bind(box);
    let slowPollDone = false;
    box.request = async (req) => {
      if (req.path.endsWith("/poll") && !slowPollDone) {
        // A door call blocking on a human tap looks exactly like this from here.
        await wait(60);
        slowPollDone = true;
        return {
          status: 200,
          headers: {},
          body: encoder.encode(JSON.stringify({ events: [], cursor: 0, done: false })),
        };
      }
      return request(req);
    };
    await machine.send({ prompt: "p", emit: () => undefined });
    // Three times the idle budget later, the box is still there.
    expect(sandbox.boxes[0]!.destroyed).toBe(false);
  });
});

describe("the build's own dev server is reachable from the browser (blueprint §10.2)", () => {
  test("the box hands out its provider ingress URL for a port its own traffic never uses", async () => {
    // A coded build's preview is the TEMPLATE's dev server, on a second listener
    // in the same box. `request()` already reaches any port from the HOST side;
    // this is the browser→box side, which the session seam could not express.
    const sandbox = fakeSandbox(async () => undefined);
    const machine = await boxMachine({ sandbox, threadId: "thr_preview", env: {}, allowedDomains: [] });
    expect(await machine.url(5173)).toBe("https://box_0-5173.fake-provider.test");
  });
});

describe("skills are OURS by name — the machine's own skills never join the set", () => {
  /** What the harness actually told the box to enable. */
  const enabledFor = async (skills?: Array<{ name: string; description: string }>) => {
    let sent: unknown;
    const sandbox = fakeSandbox(async () => undefined);
    const original = sandbox.create.bind(sandbox);
    sandbox.create = async (spec) => {
      const box = await original(spec);
      const request = box.request.bind(box);
      box.request = async (req) => {
        if (req.path === "/session/message" && req.body !== undefined) {
          sent = JSON.parse(decoder.decode(req.body as Uint8Array));
        }
        return request(req);
      };
      return box;
    };
    await drain(claudeCode({ sandbox }), makeTurn({ ...(skills === undefined ? {} : { skills }) }).turn);
    return sent as { skillNames?: string[]; pluginPath?: string };
  };

  test("the enabled set is exactly turn.skills.list() — an operator skill on the machine is NOT in it", async () => {
    // MEASURED LIVE 2026-08-02: `skills: "all"` enabled every skill the engine
    // DISCOVERED, which on a host running machine:"local" included the operator's
    // own ~/.claude/skills (a probe saw deep-research, dataviz, claude-api beside
    // ours). That is the operator's private tooling joining a customer's agent.
    // The live probe then confirmed a named filter excludes them: invoking an
    // unlisted operator skill returns FAILED. This pins the mechanism that makes
    // it true — the enabled list is ours, by name, and nothing else can get in.
    const sent = await enabledFor([
      { name: "refund-policy", description: "Maple's refund rules." },
      { name: "invoice-tone", description: "How Maple writes to late payers." },
    ]);
    expect(sent.skillNames).toEqual(["refund-policy", "invoice-tone"]);
    // Never the wildcard, whose whole problem is that it is not a list.
    expect(sent.skillNames).not.toContain("all");
    // `dataviz` etc. exist on the operator's disk, not in the turn's listing, so
    // they are absent by construction rather than by filtering.
    expect(sent.skillNames).not.toContain("dataviz");
  });

  test("a host with NO skills sends no plugin and no skill names at all", async () => {
    const sent = await enabledFor();
    expect(sent.skillNames).toBeUndefined();
    expect(sent.pluginPath).toBeUndefined();
  });
});

describe("§1.3 · truncated() — the one bit that replaced the rewind ledger", () => {
  test("a GROWN transcript is an ordinary next message", () => {
    expect(truncated({ sessionId: "s", covers: 3 }, 5)).toBe(false);
  });

  test("an EQUAL-length transcript is a REGENERATE — the reply it remembers is gone", () => {
    // `covers` counts the answering turn's INPUTS, so its reply lands at index
    // `covers`; an equal-length history means that reply was thrown away.
    expect(truncated({ sessionId: "s", covers: 3 }, 3)).toBe(true);
  });

  test("a SHORTER transcript is a delete-from-here", () => {
    expect(truncated({ sessionId: "s", covers: 5 }, 2)).toBe(true);
  });

  test("a session that never answered has nothing to have thrown away", () => {
    expect(truncated({ sessionId: "s" }, 3)).toBe(false);
    expect(truncated({}, 3)).toBe(false);
  });

  test("a LEGACY rewind ledger in carried state is simply ignored", () => {
    // Threads mid-flight when this shipped carry `rewind: [...]`. It is not read,
    // and its presence must not change the verdict.
    expect(truncated({ sessionId: "s", covers: 3, rewind: [{ at: 1, uuid: "u1" }] } as never, 3)).toBe(true);
  });
});

describe("a turn on a real box wire", () => {
  test("the workspace is materialized, the box edits it, and the diff lands in the store", async () => {
    const sandbox = fakeSandbox(async (box) => {
      expect(box.read("/user/apps/app_1/app.vendo")).toBe("<App/>");
      box.write("/user/apps/app_1/app.vendo", "<App>edited</App>");
      box.emit({ type: "text", delta: "Done." });
      box.emit({ type: "session", sessionId: "sess_1" });
    });
    const { turn, workspace, state } = makeTurn({ files: { "/user/apps/app_1/app.vendo": "<App/>" } });
    const events = await drain(claudeCode({ sandbox }), turn);

    expect(events).toContainEqual({ type: "text", delta: "Done." });
    expect(await workspace.readFile("/user/apps/app_1/app.vendo")).toBe("<App>edited</App>");
    // The native session ref is carried, opaquely, in turn.state (§1.3).
    expect(JSON.parse(state.pending().value!)).toMatchObject({ sessionId: "sess_1" });
  });

  test("the driver mints a credential and hands the box the door — the only way it reaches the world", async () => {
    let seen: { url: string; token: string } | undefined;
    const sandbox = fakeSandbox(async (box) => { seen = box.toolDoor; });
    const harness = claudeCode({ sandbox });
    const minted: string[] = [];
    provideHarnessAdapters(harness, {
      toolDoor: {
        url: "https://app.example.com/api/vendo/mcp",
        mint: (threadId: string) => {
          minted.push(threadId);
          return `vtk_for_${threadId}`;
        },
        revoke: () => undefined,
      },
    });
    const { turn } = makeTurn({ threadId: "thr_mint" });
    await drain(harness, turn);

    // Minted for THIS conversation, and named by nothing else: the registry
    // reads the subject off the turn in flight (`turn-credentials.ts`).
    expect(minted).toEqual(["thr_mint"]);
    expect(seen).toEqual({
      url: "https://app.example.com/api/vendo/mcp",
      token: "vtk_for_thr_mint",
    });
  });

  test("ONE credential per conversation — a warm machine's second message reuses it, because a live session's headers are fixed at open", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    const harness = claudeCode({ sandbox });
    let issued = 0;
    provideHarnessAdapters(harness, {
      toolDoor: {
        url: "https://app.example.com/api/vendo/mcp",
        mint: () => `vtk_${(issued += 1)}`,
        revoke: () => undefined,
      },
    });
    await drain(harness, makeTurn({ threadId: "thr_one_cred" }).turn);
    await drain(harness, makeTurn({ threadId: "thr_one_cred" }).turn);

    // A second mint per turn would leak a live credential per message. Safe
    // because the AUTHORITY is per turn regardless of how old the token is.
    expect(issued).toBe(1);
  });

  test("an AUTO-MOUNTED door with no origin RUNS the turn workspace-only — the shape a host that never configured `mcp` deploys", async () => {
    // (b) in the door-origin split: composition mounted this door purely
    // because the harness declares `requires.toolDoor`; the host never wrote
    // `mcp` and never named an origin. That is a supported deployment — a
    // workspace-only assistant doing file work — and it ran for the whole
    // rebuild until `requires.toolDoor` became unconditional.
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    let booted = false;
    let seen: { url: string; token: string } | undefined;
    const sandbox = fakeSandbox(async (box) => { booted = true; seen = box.toolDoor; });
    const harness = claudeCode({ sandbox });
    provideHarnessAdapters(harness, {
      toolDoor: { url: undefined, autoMounted: true, mint: () => "vtk_auto", revoke: () => undefined },
    });

    const events = await drain(harness, makeTurn().turn);
    spy.mockRestore();

    // It ran: no refusal.
    expect(events).not.toContainEqual({
      type: "error",
      message: "I can't use this product's actions right now.",
    });
    // Box hands: the machine booted, so the agent has its workspace.
    expect(booted).toBe(true);
    // ...and no product tools: there is no origin to reach them over, so the
    // box is handed no door rather than an unreachable one.
    expect(seen).toBeUndefined();
    // The operator hears it, once. `warnNoOriginOnce` is once per PROCESS, so
    // this must remain the only test in this file asserting the sentence.
    expect(errors.join("\n")).toContain("NONE of your product's actions");
  });

  test("an AUTO-MOUNTED door WITH a reachable origin still hands the box full tools — auto-mounting suppresses nothing", async () => {
    let seen: { url: string; token: string } | undefined;
    const sandbox = fakeSandbox(async (box) => { seen = box.toolDoor; });
    const harness = claudeCode({ sandbox });
    provideHarnessAdapters(harness, {
      toolDoor: {
        url: "https://app.example.com/api/vendo/mcp",
        autoMounted: true,
        mint: () => "vtk_auto_ok",
        revoke: () => undefined,
      },
    });

    await drain(harness, makeTurn({ threadId: "thr_auto_reachable" }).turn);

    expect(seen).toEqual({
      url: "https://app.example.com/api/vendo/mcp",
      token: "vtk_auto_ok",
    });
  });

  test("a HOST-CONFIGURED door with no reachable URL still REFUSES — an explicit `mcp` that no box can reach is a misconfiguration, not a posture", async () => {
    // (a) in the split, stated explicitly rather than by omission: the host
    // asked for a door. Running on would hand the model a workspace and no
    // hands while the operator believes their tools are live.
    const sandbox = fakeSandbox(async () => undefined);
    const harness = claudeCode({ sandbox });
    provideHarnessAdapters(harness, {
      toolDoor: { url: undefined, autoMounted: false, mint: () => "vtk_y", revoke: () => undefined },
    });

    const events = await drain(harness, makeTurn().turn);

    expect(events).toContainEqual({
      type: "error",
      message: "I can't use this product's actions right now.",
    });
  });

  test("a door with no reachable URL REFUSES the turn — a model with a workspace and no hands is not a degradation to ship", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    const harness = claudeCode({ sandbox });
    provideHarnessAdapters(harness, {
      toolDoor: { url: undefined, mint: () => "vtk_x", revoke: () => undefined },
    });
    const events = await drain(harness, makeTurn().turn);
    expect(events).toContainEqual({
      type: "error",
      message: "I can't use this product's actions right now.",
    });
  });

  test("D2 · Turn.system reaches the box WHOLE and ALONE — nothing appended after it", async () => {
    // The D2 plumbing question, measured rather than read: the composed brief
    // (which carries "Never claim a tool ran unless its result confirms that it
    // did") is what `vendo()` thinks with, and it must be what the box thinks
    // with too. EXACTLY: the hard-coded embedding briefing this harness used to
    // append after the host's prompt is gone — that voice belongs to the host's
    // prompt seam, which a trailing append could never be overridden through.
    let brief: string | undefined;
    const sandbox = fakeSandbox(async (box) => { brief = box.systemPrompt; });
    await drain(claudeCode({ sandbox }), makeTurn().turn);
    expect(brief).toBe("PRODUCT BRIEF");
  });

  test("NO tool listing travels to the box any more — the door lists live, so nothing can go stale", async () => {
    let payload: Record<string, unknown> | undefined;
    const sandbox = fakeSandbox(async () => undefined);
    const { turn } = makeTurn();
    const original = sandbox.create.bind(sandbox);
    sandbox.create = async (spec) => {
      const box = await original(spec);
      const request = box.request.bind(box);
      box.request = async (req) => {
        if (req.path === "/session/message" && req.body !== undefined) {
          payload = JSON.parse(decoder.decode(req.body as Uint8Array)) as Record<string, unknown>;
        }
        return request(req);
      };
      return box;
    };
    await drain(claudeCode({ sandbox }), turn);
    // The snapshot-once limitation died with the projection: an SDK MCP server's
    // tool set is fixed at session open, so a tool `find_tools` equipped
    // mid-conversation used to cost a session REOPEN. `tools/list` at the door
    // is answered from `turn.tools.list()` on every ask.
    expect(payload).toBeDefined();
    expect(payload!["tools"]).toBeUndefined();
  });

  test("/user/scratch never leaves the box, and /host is never written back", async () => {
    const sandbox = fakeSandbox(async (box) => {
      box.write("/user/scratch/notes.txt", "junk");
      box.write("/host/skills/a/SKILL.md", "rewritten");
      box.write("/user/memory/keep.md", "kept");
    });
    const { turn, workspace } = makeTurn({ files: { "/host/skills/a/SKILL.md": "original" } });
    await drain(claudeCode({ sandbox }), turn);
    expect(await workspace.exists("/user/scratch/notes.txt")).toBe(false);
    expect(await workspace.readFile("/host/skills/a/SKILL.md")).toBe("original");
    expect(await workspace.readFile("/user/memory/keep.md")).toBe("kept");
  });

  test("a box-side plan write lands MID-TURN, so the skeleton renders before the turn ends", async () => {
    let landed: string[] | undefined;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sandbox = fakeSandbox(async (box) => {
      box.write("/user/apps/app_1/plan.vendo", "plan v1");
      // Stay inside the turn until the host has committed it — a landing after
      // the turn ended would prove nothing about the skeleton.
      await held;
      box.emit({ type: "text", delta: "done" });
    });
    const { turn, workspace } = makeTurn({ files: { "/user/apps/app_1/app.vendo": "<App/>" } });
    const watcher = setInterval(() => {
      const commit = workspace.commits.find((entry) =>
        entry.changed.includes("/user/apps/app_1/plan.vendo"));
      if (commit !== undefined) { landed = commit.changed; release(); }
    }, 20);
    const guard = setTimeout(release, 8_000);
    await drain(claudeCode({ sandbox }), turn);
    clearInterval(watcher);
    clearTimeout(guard);
    // ONLY the hot path: the mid-turn sync never drags the rest of the tree along.
    expect(landed).toEqual(["/user/apps/app_1/plan.vendo"]);
  }, 15_000);

  test("D5 · a plan for a BRAND-NEW app lands mid-turn too — the skeleton is what a new app needs most", async () => {
    // The measured bug: the hot set was pre-enumerated from files that already
    // existed, so the one case the skeleton exists for — "make me an app" —
    // watched nothing and the user sat through 52.8s of silence.
    let landed: string[] | undefined;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sandbox = fakeSandbox(async (box) => {
      box.write("/user/apps/app_brandnew/plan.vendo", "plan v1");
      await held;
      box.emit({ type: "text", delta: "done" });
    });
    // NO app directory at turn start: only unrelated user files.
    const { turn, workspace } = makeTurn({ files: { "/user/memory/keep.md": "kept" } });
    const watcher = setInterval(() => {
      const commit = workspace.commits.find((entry) =>
        entry.changed.includes("/user/apps/app_brandnew/plan.vendo"));
      if (commit !== undefined) { landed = commit.changed; release(); }
    }, 20);
    const guard = setTimeout(release, 8_000);
    await drain(claudeCode({ sandbox }), turn);
    clearInterval(watcher);
    clearTimeout(guard);
    expect(landed).toEqual(["/user/apps/app_brandnew/plan.vendo"]);
  }, 15_000);

  test("killing the sandbox mid-turn leaves the store untouched, and the next turn recovers", async () => {
    const sandbox = fakeSandbox(async (box) => {
      box.write("/user/apps/app_1/app.vendo", "<App>half</App>");
      // The provider reaps the machine mid-turn: every later request throws
      // not-found, so the half-written app can never be read back.
      box.kill();
    });
    const { turn, workspace } = makeTurn({ files: { "/user/apps/app_1/app.vendo": "<App/>" } });
    await drain(claudeCode({ sandbox }), turn);
    expect(await workspace.readFile("/user/apps/app_1/app.vendo")).toBe("<App/>");

    await disposeSessionMachines();
    const healthy = fakeSandbox(async (box) => {
      box.write("/user/apps/app_1/app.vendo", "<App>whole</App>");
    });
    const second = makeTurn({ files: { "/user/apps/app_1/app.vendo": "<App/>" } });
    await drain(claudeCode({ sandbox: healthy }), second.turn);
    expect(await second.workspace.readFile("/user/apps/app_1/app.vendo")).toBe("<App>whole</App>");
  });

  test("the machine pool keys on Turn.threadId FIRST — a history edit cannot orphan the session", async () => {
    // The amendment's whole point (ccaba80a7): `messages[0].id` changes when
    // the user edits the first message and resends; the thread's identity does
    // not. Same threadId + different first-message id must be ONE machine.
    let creates = 0;
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "ok" }); });
    const original = sandbox.create.bind(sandbox);
    sandbox.create = async (spec) => { creates += 1; return original(spec); };
    const harness = claudeCode({ sandbox });
    const first = makeTurn({ threadId: "thr_named", messages: [{ id: "m_a", text: "hi" }] });
    await drain(harness, first.turn);
    const second = makeTurn({ threadId: "thr_named", messages: [{ id: "m_edited", text: "hi again" }] });
    await drain(harness, second.turn);
    expect(creates).toBe(1);
  });

  test("D4 · a pooled machine the provider reaped is EVICTED, so the next turn on that thread recovers", async () => {
    // The live half of the kill law. The test above disposes the pool between
    // turns, which is exactly what hid this: in a real server the dead entry
    // stays, and every later turn on that thread was handed the corpse — 0.3s
    // failures for the life of the process, recoverable only by a restart.
    let boxTurn = 0;
    const sandbox = fakeSandbox(async (box) => {
      boxTurn += 1;
      if (boxTurn === 1) {
        box.write("/user/apps/app_1/app.vendo", "<App>half</App>");
        box.kill();
        return;
      }
      box.write("/user/apps/app_1/app.vendo", "<App>whole</App>");
    });
    const harness = claudeCode({ sandbox });
    const first = makeTurn({ thread: "thr_bricked", files: { "/user/apps/app_1/app.vendo": "<App/>" } });
    await drain(harness, first.turn);
    expect(await first.workspace.readFile("/user/apps/app_1/app.vendo")).toBe("<App/>");

    // SAME thread, SAME process, pool NOT disposed.
    const second = makeTurn({ thread: "thr_bricked", files: { "/user/apps/app_1/app.vendo": "<App/>" } });
    await drain(harness, second.turn);
    expect(await second.workspace.readFile("/user/apps/app_1/app.vendo")).toBe("<App>whole</App>");
    expect(sandbox.boxes).toHaveLength(2);
  });

  test("one machine per session: a second turn on the same thread reuses it", async () => {
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "session", sessionId: "sess_1" }); });
    const harness = claudeCode({ sandbox });
    await drain(harness, makeTurn({ thread: "thr_reuse" }).turn);
    await drain(harness, makeTurn({ thread: "thr_reuse", state: JSON.stringify({ sessionId: "sess_1" }) }).turn);
    expect(sandbox.boxes).toHaveLength(1);
  });

  test("a second turn does not RESUME anything — it continues a session that never stopped", async () => {
    // This is the cc-native change, stated as the thing it replaced. The old
    // shape opened a NEW query() per message and handed it `resume: <sessionId>`
    // to buy back the memory it had just thrown away. A live session never threw
    // it away, so there is nothing to resume: the box is opened once and answers
    // both messages.
    const opens: Array<string | undefined> = [];
    const sandbox = fakeSandbox(async (box) => {
      opens.push(box.resume);
      box.emit({ type: "session", sessionId: "sess_1" });
    });
    const harness = claudeCode({ sandbox });
    await drain(harness, makeTurn({ thread: "thr_resume" }).turn);
    await drain(harness, makeTurn({ thread: "thr_resume", state: JSON.stringify({ sessionId: "sess_1" }) }).turn);

    // One box, one session, two messages — and no resume ref on either.
    expect(sandbox.boxes).toHaveLength(1);
    expect(sandbox.boxes[0]?.messages).toBe(2);
    expect(opens).toEqual([undefined, undefined]);
  });

  test("§1.3 · a REGENERATE on a warm session drops the session and re-seeds, so the discarded answer is forgotten", async () => {
    // The failure this replaces: `rewindFor` computed resume/resumeAt and the box
    // driver sent them, but the box door never read `payload.resumeAt` and a warm
    // session never reopened — so a regenerate left the answer the user just threw
    // away sitting in the model's memory. The machinery existed and did nothing.
    //
    // The fix is deletion plus one honest fallback: a transcript that did not GROW
    // means a truncation, so the session is dropped and the thread re-seeds from
    // OUR transcript. Never wrong, only slower — and regenerate is the rare path.
    const seen: Array<{ resume?: string; prompt?: string }> = [];
    const sandbox = fakeSandbox(async (box) => {
      seen.push({ ...(box.resume === undefined ? {} : { resume: box.resume }), prompt: box.prompt });
      box.emit({ type: "session", sessionId: "sess_regen" });
      box.emit({ type: "text", delta: "answer" });
    });
    const harness = claudeCode({ sandbox });

    // Turn 1 — one user message, session opens.
    const first = makeTurn({ thread: "thr_regen" });
    await drain(harness, first.turn);
    expect(JSON.parse(first.state.pending().value!)).toMatchObject({
      sessionId: "sess_regen",
      covers: 1,
    });

    // The user REGENERATES: the transcript did not grow (2 messages against a
    // session that already answered 3), so the reply it remembers is gone. The
    // carried state holds a checkpoint BEFORE the removal — precisely the case
    // the old ledger claimed to rewind through, and silently did not.
    const regenerated = makeTurn({
      thread: "thr_regen",
      state: JSON.stringify({
        sessionId: "sess_regen",
        covers: 3,
        rewind: [{ at: 1, uuid: "uuid_turn1" }],
      }),
      messages: [{ id: "thr_regen", text: "make me a dashboard" }, { id: "m2", text: "no, a chart" }],
    });
    await drain(harness, regenerated.turn);

    // A FRESH session, not a resumed one — nothing carried over.
    expect(seen[1]?.resume).toBeUndefined();
    // And the history arrives as OUR re-seed, so the conversation continues while
    // the discarded answer does not.
    expect(seen[1]?.prompt).toContain("conversation so far");
    expect(seen[1]?.prompt).toContain("make me a dashboard");
    // One box: the session was reopened on it, not replaced with a new machine.
    expect(sandbox.boxes).toHaveLength(1);
  });

  test("an APPEND on a warm session keeps it — only a truncation costs the session", async () => {
    const seen: Array<string | undefined> = [];
    const sandbox = fakeSandbox(async (box) => {
      seen.push(box.prompt);
      box.emit({ type: "session", sessionId: "sess_append" });
    });
    const harness = claudeCode({ sandbox });

    await drain(harness, makeTurn({ thread: "thr_append" }).turn);
    // Transcript GREW (2 > 1), which is an ordinary next message.
    await drain(harness, makeTurn({
      thread: "thr_append",
      state: JSON.stringify({ sessionId: "sess_append", covers: 1 }),
      messages: [{ id: "thr_append", text: "make me a dashboard" }, { id: "m2", text: "add a total" }],
    }).turn);

    // The live session already holds the history, so turn 2 says only what the
    // user just said — no re-seed.
    expect(seen[1]).toBe("add a total");
    expect(seen[1]).not.toContain("conversation so far");
  });

  test("an out-of-band store WRITE mid-conversation is not reverted by the warm box's stale copy", async () => {
    // The hazard: a warm box's tree dates from conversation start and is never
    // re-materialized (that is what makes turn 2 free). If the turn-end diff is
    // taken against a FRESH store read, then a file someone else changed in the
    // store hash-mismatches the box's stale copy and gets written BACK — the
    // newer state is destroyed by a turn that never touched the file.
    //
    // Who else writes: another thread of the same user, an app tool, an
    // automation, a second harness. All real.
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "ok" }); });
    const harness = claudeCode({ sandbox });
    const workspace = testWorkspace({ "/user/memory/note.md": "turn-1 content\n" });

    await drain(harness, makeTurn({ thread: "thr_clobber", workspace }).turn);

    // OUT OF BAND, between turns. The box never learns about this.
    await workspace.writeFile("/user/memory/note.md", new TextEncoder().encode("newer content\n"));
    await workspace.commit();

    // Turn 2 on the WARM box. The box touched nothing.
    await drain(harness, makeTurn({ thread: "thr_clobber", workspace }).turn);

    // "Unchanged in the box" has to mean SKIP, never overwrite.
    expect(new TextDecoder().decode(await workspace.readFileBuffer("/user/memory/note.md")))
      .toBe("newer content\n");
  });

  test("an out-of-band store DELETE mid-conversation is not resurrected by the warm box's stale copy", async () => {
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "ok" }); });
    const harness = claudeCode({ sandbox });
    const workspace = testWorkspace({ "/user/memory/gone.md": "delete me\n" });

    await drain(harness, makeTurn({ thread: "thr_resurrect", workspace }).turn);

    await workspace.rm("/user/memory/gone.md", { force: true });
    await workspace.commit();

    await drain(harness, makeTurn({ thread: "thr_resurrect", workspace }).turn);

    // A file the box still has on disk but nobody owns any more must stay gone.
    expect(workspace.getAllPaths()).not.toContain("/user/memory/gone.md");
  });

  test("the box's OWN edit still lands on a warm box — the fix must not turn sync-back off", async () => {
    // The other half of the invariant: skipping unchanged files must not skip
    // CHANGED ones. Turn 2 writes, and that write is the box's, so it commits.
    let turn = 0;
    const sandbox = fakeSandbox(async (box) => {
      turn += 1;
      if (turn === 2) box.write("/user/memory/note.md", "the box wrote this\n");
      box.emit({ type: "text", delta: "ok" });
    });
    const harness = claudeCode({ sandbox });
    const workspace = testWorkspace({ "/user/memory/note.md": "original\n" });

    await drain(harness, makeTurn({ thread: "thr_boxedit", workspace }).turn);
    await drain(harness, makeTurn({ thread: "thr_boxedit", workspace }).turn);

    expect(new TextDecoder().decode(await workspace.readFileBuffer("/user/memory/note.md")))
      .toBe("the box wrote this\n");
  });

  test("a second turn on a WARM box does not re-materialize the workspace", async () => {
    // Proof 1's other half: the box's disk is the conversation's working copy, so
    // resetting it between messages would throw away exactly what the live
    // session is holding open.
    const resets: number[] = [];
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "ok" }); });
    const original = sandbox.create.bind(sandbox);
    sandbox.create = async (spec) => {
      const box = await original(spec);
      const request = box.request.bind(box);
      box.request = async (req) => {
        if (req.path === "/session/workspace" && req.body !== undefined) {
          const body = JSON.parse(decoder.decode(req.body as Uint8Array)) as { reset?: boolean };
          if (body.reset === true) resets.push(1);
        }
        return request(req);
      };
      return box;
    };
    const harness = claudeCode({ sandbox });
    await drain(harness, makeTurn({ thread: "thr_mat", files: { "/user/memory/a.md": "one" } }).turn);
    await drain(harness, makeTurn({ thread: "thr_mat", files: { "/user/memory/a.md": "one" } }).turn);
    expect(resets).toHaveLength(1);
  });

  test("a composed adapter reaches a boot-constructed harness through the slot", async () => {
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "hi" }); });
    const harness = claudeCode();
    provideHarnessAdapters(harness, { sandbox });
    expect(await drain(harness, makeTurn().turn)).toContainEqual({ type: "text", delta: "hi" });
  });

  test("with no adapter anywhere the turn refuses in the consumer voice, never a stack trace", async () => {
    const events = await drain(claudeCode(), makeTurn().turn);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    expect(JSON.stringify(events[0])).not.toMatch(/sandbox|adapter|undefined/i);
  });
});

describe("mid-build steering — the user's words into the turn already in flight (§10.2)", () => {
  test("the words reach the SESSION answering this message, over the real door", async () => {
    // The whole chain, no stub on either side: the harness registers a steer
    // handler on the turn, the runtime calls it, `boxMachine` posts
    // /session/<in-flight>/steer to the REAL box door, and the door hands it to
    // the live session — which is the fake box's scripted stand-in for the SDK.
    let release: (() => void) | undefined;
    const sandbox = fakeSandbox(async (box) => {
      box.emit({ type: "text", delta: "building it" });
      await new Promise<void>((resolve) => { release = resolve; });
      box.emit({ type: "text", delta: "Got it — regrouping by client." });
    });
    const { turn } = makeTurn({ threadId: "thr_steer_box" });
    let handOver: ((text: string) => Promise<boolean>) | undefined;
    (turn as unknown as { onSteer: unknown }).onSteer = (handler: (text: string) => Promise<boolean>) => {
      handOver = handler;
    };

    const events: HarnessEvent[] = [];
    const running = (async () => {
      for await (const event of claudeCode({ sandbox }).run(turn as never)) events.push(event);
    })();

    // Wait for the build to be under way, then steer it.
    await vi.waitFor(() => expect(events).toContainEqual({ type: "text", delta: "building it" }));
    expect(handOver).toBeDefined();
    await expect(handOver!("group by client instead")).resolves.toBe(true);

    release?.();
    await running;

    expect(sandbox.boxes[0]!.steers).toEqual(["group by client instead"]);
    expect(events).toContainEqual({ type: "text", delta: "Got it — regrouping by client." });
    // ONE box, ONE message: a steer is never a second send.
    expect(sandbox.boxes).toHaveLength(1);
    expect(sandbox.boxes[0]!.messages).toBe(1);
  });

  test("a steer with nothing in flight does not land", async () => {
    const sandbox = fakeSandbox(async () => undefined);
    const { turn } = makeTurn({ threadId: "thr_steer_idle" });
    let handOver: ((text: string) => Promise<boolean>) | undefined;
    (turn as unknown as { onSteer: unknown }).onSteer = (handler: (text: string) => Promise<boolean>) => {
      handOver = handler;
    };
    await drain(claudeCode({ sandbox }), turn);
    // The turn is over; the machine has no message to fold words into.
    await expect(handOver!("too late")).resolves.toBe(false);
  });

  test("a harness turn whose runtime offers no steering channel still runs", async () => {
    // `onSteer` is OPTIONAL by construction: every harness and every driver that
    // predates steering is unchanged.
    const sandbox = fakeSandbox(async (box) => { box.emit({ type: "text", delta: "hi" }); });
    expect(await drain(claudeCode({ sandbox }), makeTurn({ threadId: "thr_no_steer" }).turn))
      .toContainEqual({ type: "text", delta: "hi" });
  });
});

describe("stop is still the only thing that cancels — steering never does", () => {
  test("an aborted turn reaches ClaudeSession.interrupt() through the door, unchanged", async () => {
    // `interrupt()` is NOT unused and never was: Stop → `thread.stop()` → the
    // request abort → `turn.signal`, which the poll loop turns into
    // POST /session/<id>/interrupt, which the door hands to the live session.
    // This pins that chain so steering cannot quietly become the stop path.
    const abort = new AbortController();
    let release: (() => void) | undefined;
    const sandbox = fakeSandbox(async (box) => {
      box.emit({ type: "text", delta: "building it" });
      // The box then goes QUIET — a long tool call, which is exactly when a user
      // reaches for Stop. The door parks the poll for POLL_WAIT_MS with nothing
      // to say, so an interrupt that rides the poll loop cannot arrive until the
      // park expires. Nothing may wake this box before the assertion below.
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const { turn } = makeTurn({ threadId: "thr_stop" });
    (turn as unknown as { signal: AbortSignal }).signal = abort.signal;

    const events: HarnessEvent[] = [];
    const running = (async () => {
      for await (const event of claudeCode({ sandbox }).run(turn as never)) events.push(event);
    })();
    await vi.waitFor(() => expect(events).toContainEqual({ type: "text", delta: "building it" }));

    abort.abort();
    // PROMPTLY is the whole assertion: the box is silent, so a poll is parked for
    // POLL_WAIT_MS (10s) right now. 3s is far above any scheduling noise and far
    // below that park, so crossing it means the interrupt waited for the poll.
    await vi.waitFor(() => expect(sandbox.boxes[0]!.interrupted).toBe(true), { timeout: 3_000 });
    release?.();
    await running;
  });

  test("a steer never interrupts — the turn it joined keeps running", async () => {
    let release: (() => void) | undefined;
    const sandbox = fakeSandbox(async (box) => {
      box.emit({ type: "text", delta: "building it" });
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const { turn } = makeTurn({ threadId: "thr_steer_no_stop" });
    let handOver: ((text: string) => Promise<boolean>) | undefined;
    (turn as unknown as { onSteer: unknown }).onSteer = (handler: (text: string) => Promise<boolean>) => {
      handOver = handler;
    };

    const events: HarnessEvent[] = [];
    const running = (async () => {
      for await (const event of claudeCode({ sandbox }).run(turn as never)) events.push(event);
    })();
    await vi.waitFor(() => expect(events).toContainEqual({ type: "text", delta: "building it" }));
    await handOver!("group by client instead");

    expect(sandbox.boxes[0]!.interrupted).toBe(false);
    release?.();
    await running;
    expect(sandbox.boxes[0]!.interrupted).toBe(false);
  });
});

/**
 * §4.4's loadout, items 2 and 3: the builder's two REFERENCES, on disk, where the
 * `building-apps` skill tells it to look.
 *
 * Both already exist and are already generated — `hostComponentFiles(catalog)`
 * writes `/host/components/<Name>.md` and `buildingAppsSkill.files` carries
 * `references/format.md`, which is `kitPrompt()`'s output, not a hand-written
 * second copy. What nothing proved is the HOP: that the projection composition
 * assembles actually reaches the machine's disk, at a path the skill's own
 * workspace-relative instructions resolve against.
 *
 * That is precisely the producer/consumer seam this repo shipped four times green
 * and dead, so it is tested through the REAL box door with nothing stubbed on
 * either side: a real checkout, a real materialize, a real in-box walk.
 */
describe("the builder's references reach the box's disk (§4.4 loadout)", () => {
  /** Exactly what `hostSkillFiles` + `hostComponentFiles` project, in shape. */
  const HOST_FILES = {
    "/host/components/DataTable.md": "# DataTable\n\nRows of things.\n\n## Props\n\n```json\n{}\n```\n",
    "/host/skills/building-apps/SKILL.md": "---\nname: building-apps\ndescription: Build an app.\n---\n\nbody\n",
    "/host/skills/building-apps/references/format.md": "# The .vendo format\n\n<App>…</App>\n",
  };

  test("the component reference and the format reference are both readable in the box", async () => {
    const seen: Record<string, string | undefined> = {};
    const sandbox = fakeSandbox(async (box) => {
      // The skill body sends the builder to `host/components/` and
      // `host/skills/building-apps/references/format.md`, RELATIVE to its cwd.
      // The box's cwd is the workspace root, so these are the resolved paths.
      for (const path of Object.keys(HOST_FILES)) seen[path] = box.read(path);
    });
    const { turn } = makeTurn({ files: { ...HOST_FILES, "/user/apps/app_1/app.vendo": "<App/>" } });
    await drain(claudeCode({ sandbox }), turn);

    expect(seen).toEqual(HOST_FILES);
  });

  // "the references are never carried home" is NOT tested here on purpose:
  // `/user/scratch never leaves the box, and /host is never written back` above
  // already pins it through the same real door, and a second copy of it would be
  // a test that has to be kept in step with nothing.

  test("the /host mount IS the SDK plugin root — one skills mechanism, not two", async () => {
    let pluginRoot: string | undefined;
    const sandbox = fakeSandbox(async (box) => { pluginRoot = box.read("/host/skills/building-apps/SKILL.md"); });
    const { turn } = makeTurn({
      files: HOST_FILES,
      skills: [{ name: "building-apps", description: "Build an app." }],
    });
    await drain(claudeCode({ sandbox }), turn);

    // The plugin path the driver hands the SDK and the mount the skill file lands
    // on are the same directory, which is why no projection or copy exists.
    expect(pluginRoot).toBe(HOST_FILES["/host/skills/building-apps/SKILL.md"]);
  });
});

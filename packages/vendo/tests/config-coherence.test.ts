/**
 * The config-coherence change, proven on real compositions.
 *
 * Four keys reshaped, twelve spellings deleted, and the claim is that NOTHING
 * behaves differently — this is surface, not semantics. A rename that quietly
 * changes a guard decision, a system prompt, or a connector catalog is the
 * failure mode, so each of the three is pinned against the literal main
 * produced, not against "the new code agrees with itself".
 *
 * The old shapes are gone, so they cannot be composed side by side. What is
 * asserted instead is the literal: the guard decisions main's
 * `policy: { rules }` produced, the prompt section main's `brief` landed in,
 * and the scoped catalog main's `connectorApps` produced (the same literals
 * `server.test.ts` has pinned since the connectorApps criterion landed).
 *
 * Each assertion here has been driven red by reverting the line it covers —
 * see the comment on each block for which line, and what it says when broken.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDO_TOOLS_FORMAT, type ExtractedTool } from "@vendoai/actions";
import { VendoError, type Principal, type RunContext } from "@vendoai/core";
import { createGuard, guard as guardRules } from "@vendoai/guard";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDeprecationWarnings } from "../src/config-keys.js";
import { createVendo, type Vendo } from "../src/server.js";

const principal: Principal = { kind: "user", subject: "user_coherence" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "ses_coherence" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(prefix: string): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  return store;
}

const routeTool = (name: string, extras: Partial<ExtractedTool> = {}): ExtractedTool => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object" },
  risk: "read",
  binding: { kind: "route", method: "GET", path: `/${name}`, argsIn: "query" },
  ...extras,
});

/** The three-risk host surface every decision case below is graded against. */
const HOST_TOOLS: ExtractedTool[] = [
  routeTool("host_read"),
  routeTool("host_write", {
    risk: "write",
    binding: { kind: "route", method: "POST", path: "/host_write", argsIn: "body" },
  }),
  routeTool("host_wipe", {
    risk: "destructive",
    binding: { kind: "route", method: "DELETE", path: "/host_wipe", argsIn: "body" },
  }),
];

/** A cwd holding `.vendo/`, so a composition reads real surface files. */
async function dotVendo(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-coherence-root-"));
  const previousCwd = process.cwd();
  cleanups.push(async () => {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, ".vendo"));
  await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
    format: VENDO_TOOLS_FORMAT,
    tools: HOST_TOOLS,
  }));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, ".vendo", name), body);
  }
  process.chdir(root);
  return root;
}

/** Every host call answers 200, so an outcome's status is the GUARD's answer. */
function stubHostFetch(): void {
  vi.stubEnv("VENDO_BASE_URL", "https://host.test");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })));
}

const call = (tool: string) => ({ id: `call_${tool}`, tool, args: {} });

/** run / ask / block, as the wire sees them. */
async function decisions(vendo: Vendo): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const tool of ["host_read", "host_write", "host_wipe"]) {
    out[tool] = (await vendo.guardedTools.execute(call(tool), ctx)).status;
  }
  return out;
}

/**
 * The decision table main produced for
 * `createVendo({ policy: { rules: [write→ask, destructive→block] } })`.
 * Reads run (no rule matches and the unmatched default runs), the write parks,
 * the destructive is refused.
 */
const MAIN_DECISIONS = {
  host_read: "ok",
  host_write: "pending-approval",
  host_wipe: "blocked",
} as const;

const RULES = {
  rules: [
    { match: { risk: "write" as const }, action: "ask" as const },
    { match: { risk: "destructive" as const }, action: "block" as const },
  ],
};

describe("guard: one slot, two arms, the same decisions main made", () => {
  it("the SPEC arm reproduces main's decision table verbatim", async () => {
    // RED: drop `...(guardRules.judge …)`/`policy: configPolicy` from the
    // createGuard call in server.ts and every row becomes "ok" — an
    // unconfigured guard runs everything.
    await dotVendo();
    stubHostFetch();
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore("vendo-coherence-spec-"),
      guard: guardRules({ policy: RULES }),
    });
    expect(await decisions(vendo)).toEqual(MAIN_DECISIONS);
    expect(vendo.guard.status().posture).toBe("rules");
  });

  it("a bare rules OBJECT is the same value — `guard()` is naming, not behaviour", async () => {
    await dotVendo();
    stubHostFetch();
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore("vendo-coherence-bare-"),
      guard: { policy: RULES },
    });
    expect(await decisions(vendo)).toEqual(MAIN_DECISIONS);
  });

  it("an INSTANCE is taken verbatim — the composition adds nothing to it", async () => {
    // The adapter rule: a host that built its own guard gets exactly that
    // guard, so the rules it was built with are the rules in force.
    await dotVendo();
    stubHostFetch();
    const store = await tempStore("vendo-coherence-instance-");
    const built = createGuard({ store, policy: RULES });
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store,
      guard: built,
    });
    expect(vendo.guard).toBe(built);
    expect(await decisions(vendo)).toEqual(MAIN_DECISIONS);
  });

  it("the approval TTL rides the guard, so an instance keeps the knob", async () => {
    // RED: read `parkedCallTtlMs` off config again and a host that passes a
    // built guard silently gets the 60-minute default instead of its own.
    const store = await tempStore("vendo-coherence-ttl-");
    expect(createGuard({ store, approvals: { parkedCallTtlMs: 90_000 } }).approvals.parkedCallTtlMs)
      .toBe(90_000);
    expect(createGuard({ store }).approvals.parkedCallTtlMs).toBe(60 * 60_000);
    expect(() => createGuard({ store, approvals: { parkedCallTtlMs: -1 } }))
      .toThrow(VendoError);
  });

  // The breakers were real, tested and user-visible (60 calls/min, 20 writes/run)
  // with no path from `guard({ … })`: they lived on `CreateGuardConfig`, which is
  // the composition's shape, and server.ts forwarded `approvals`, `policy` and
  // `judge` but never these. Both halves are proven on a real composition —
  // RED for either: take `breakers` back off `GuardRules`, or drop the forward in
  // server.ts's `createGuard` call, and the second call below runs clean because
  // the limit in force is the default the host never chose.
  const breakerVendo = async (
    prefix: string,
    breakers: { maxCallsPerMinute?: number; maxWritesPerRun?: number },
  ): Promise<Vendo> => {
    await dotVendo();
    stubHostFetch();
    return createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore(prefix),
      guard: guardRules({ breakers }),
    });
  };

  it("the host's call-rate breaker is the one in force", async () => {
    const vendo = await breakerVendo("vendo-coherence-rate-", { maxCallsPerMinute: 1 });
    // One session, two distinct calls — a repeat of the same call id is a replay
    // the guard dedupes, which would never reach the breaker at all.
    const session: RunContext = {
      principal, venue: "chat", presence: "present", sessionId: "ses_rate",
    };
    const read = (id: string) => ({ id, tool: "host_read", args: {} });
    expect((await vendo.guardedTools.execute(read("call_r1"), session)).status).toBe("ok");
    expect((await vendo.guardedTools.execute(read("call_r2"), session)).status)
      .toBe("pending-approval");
  });

  it("the host's write budget is the one in force", async () => {
    const vendo = await breakerVendo("vendo-coherence-writes-", { maxWritesPerRun: 1 });
    const session: RunContext = {
      principal, venue: "chat", presence: "present", sessionId: "ses_writes",
    };
    const write = (id: string) => ({ id, tool: "host_write", args: {} });
    expect((await vendo.guardedTools.execute(write("call_w1"), session)).status).toBe("ok");
    expect((await vendo.guardedTools.execute(write("call_w2"), session)).status)
      .toBe("pending-approval");
  });
});

/** Records every system prompt it is asked to think with, then says one line. */
function recordingModel(seen: string[]): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "probe",
    modelId: "probe-v1",
    supportedUrls: {},
    async doStream(request: { prompt: Array<{ role: string; content: unknown }> }) {
      seen.push(
        request.prompt.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n"),
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

const PROSE = "COHERENCE-PROBE: Maple is a neobank for freelancers.";

async function promptFor(overrides: Partial<Parameters<typeof createVendo>[0]>): Promise<string> {
  const seen: string[] = [];
  const vendo = createVendo({
    models: { default: recordingModel(seen) },
    principal: async () => principal,
    store: await tempStore("vendo-coherence-prompt-"),
    ...overrides,
  } as Parameters<typeof createVendo>[0]);
  const message = { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] } as UIMessage;
  const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: `thr_${Math.random().toString(36).slice(2)}`, message }),
  }));
  await response.text();
  expect(seen.length, "the model was never asked to think").toBeGreaterThan(0);
  return seen[0]!;
}

describe("instructions: one prose story, in the section brief always had", () => {
  it("the key and the .vendo/brief.md surface produce byte-identical prompts", async () => {
    // RED: point `resolveInstructions` at the trailing `system.instructions`
    // slot instead of `product` and the two prompts stop matching, because the
    // file leg still resolves through `product`.
    await dotVendo();
    const fromKey = await promptFor({ instructions: PROSE });
    await dotVendo({ "brief.md": PROSE });
    const fromFile = await promptFor({});
    expect(fromKey).toBe(fromFile);
  });

  it("lands in the Product section, above the guard's Directions — main's placement", async () => {
    await dotVendo();
    const prompt = await promptFor({ instructions: PROSE });
    // The literal `assembleSystemPrompt` writes for `product` (prompt.ts:98).
    expect(prompt).toContain(`\n\nProduct\n${PROSE}`);
  });

  it("an adopted agent's instructions and the top-level key are one slot", async () => {
    // Filling a slot twice is a boot error, never one side silently losing.
    const { agent } = await import("@vendoai/agents");
    const { vendo: vendoHarness } = await import("@vendoai/harnesses");
    const store = await tempStore("vendo-coherence-adopt-");
    const composed = agent({ name: "support", harness: vendoHarness(), store, instructions: PROSE });
    expect(() => createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      agent: composed,
      instructions: "a second voice",
    })).toThrow(/instructions/);
  });
});

describe("connectedAccounts and connectors are two keys, two products", () => {
  /** A stub console serving a three-toolkit catalog and per-toolkit tools —
   *  the same shape `server.test.ts` has driven the scoping criterion with. */
  async function stubConsole(): Promise<string> {
    const { createServer } = await import("node:http");
    const stub = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://stub");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/api/v1/connections/catalog") {
        res.end(JSON.stringify({ available: [
          { toolkit: "gmail", connector: "composio", description: "Send and read email with Gmail" },
          { toolkit: "slack", connector: "composio", description: "Post messages to Slack channels" },
          { toolkit: "notion", connector: "composio", description: "Notion pages and databases" },
        ] }));
        return;
      }
      if (url.pathname === "/api/v1/tools") {
        const toolkits = (url.searchParams.get("toolkits") ?? "").split(",").filter(Boolean);
        res.end(JSON.stringify({ tools: toolkits.map((toolkit) => ({
          slug: `${toolkit.toUpperCase()}_SEND_THING`,
          toolkit,
          description: `use ${toolkit}`,
          inputParameters: { type: "object" },
          tags: [],
        })) }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const port = (stub.address() as { port: number }).port;
    cleanups.push(async () => {
      stub.close();
      stub.closeAllConnections();
    });
    return `http://127.0.0.1:${port}`;
  }

  const acmeConnector = {
    name: "acme",
    descriptors: async () => [{
      name: "acme_ping",
      description: "ping acme",
      inputSchema: { type: "object" },
      risk: "read" as const,
    }],
    execute: async () => ({ status: "ok" as const, output: {} }),
  };

  it("connectedAccounts scopes tools AND the connect catalog to main's literal set", async () => {
    // RED: drop `apps: toolkits` from selectConnectors and the executable
    // surface loses gmail_GMAIL_SEND_THING; drop it from selectConnections and
    // the catalog advertises slack and notion the agent cannot invoke.
    vi.stubEnv("VENDO_API_KEY", "vnd_test_key");
    vi.stubEnv("VENDO_CONSOLE_URL", await stubConsole());
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore("vendo-coherence-accounts-"),
      connectedAccounts: ["gmail"],
    });
    const names = (await vendo.actions.descriptors()).map((descriptor) => descriptor.name);
    expect(names).toContain("gmail_GMAIL_SEND_THING");
    expect(names.some((name) => name.startsWith("slack_") || name.startsWith("notion_"))).toBe(false);
    expect((await vendo.connections.catalog()).map((entry) => entry.toolkit)).toEqual(["gmail"]);
  });

  it("the OLD spelling — a service string in connectors — still composes the same surface, and says where it went", async () => {
    // The deprecation path: nothing existing breaks. RED: drop the string leg
    // from selectConnectedAccounts and the toolkit mounts nothing at all.
    resetDeprecationWarnings();
    const warn = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(warn);
    vi.stubEnv("VENDO_API_KEY", "vnd_test_key");
    vi.stubEnv("VENDO_CONSOLE_URL", await stubConsole());
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore("vendo-coherence-strings-"),
      connectors: ["gmail"],
    });
    const names = (await vendo.actions.descriptors()).map((descriptor) => descriptor.name);
    expect(names).toContain("gmail_GMAIL_SEND_THING");
    expect((await vendo.connections.catalog()).map((entry) => entry.toolkit)).toEqual(["gmail"]);
    expect(warn.mock.calls.flat().join("\n")).toMatch(/connectedAccounts: \["gmail"\]/);
  });

  it("naming services in BOTH keys is refused, never merged", async () => {
    // The one genuinely ambiguous config: which key scopes the connect dock
    // would be a guess, so it is a boot error naming both lists.
    vi.stubEnv("VENDO_API_KEY", "vnd_test_key");
    expect(() => createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      connectors: ["gmail"],
      connectedAccounts: ["slack"],
    })).toThrow(/connectors: \["gmail"\][\s\S]*connectedAccounts: \["slack"\]/);
  });

  it("connectedAccounts and connector OBJECTS mix — neither erases the other", async () => {
    // The trap `connectorApps` had: an explicit connector silently voided the
    // scope. Two keys, and each still fills its own half.
    vi.stubEnv("VENDO_API_KEY", "vnd_test_key");
    vi.stubEnv("VENDO_CONSOLE_URL", await stubConsole());
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore("vendo-coherence-mixed-"),
      connectedAccounts: ["gmail"],
      connectors: [acmeConnector],
    });
    const names = (await vendo.actions.descriptors()).map((descriptor) => descriptor.name);
    expect(names).toContain("gmail_GMAIL_SEND_THING");
    expect(names).toContain("acme_ping");
  });

  it("an empty connectedAccounts is a CHOICE — no unscoped Cloud connector sneaks in", async () => {
    // RED: treat `[]` as unset in selectConnectors and a key alone mounts the
    // console's whole catalog behind a host that said "none".
    vi.stubEnv("VENDO_API_KEY", "vnd_test_key");
    vi.stubEnv("VENDO_CONSOLE_URL", await stubConsole());
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore("vendo-coherence-none-"),
      connectedAccounts: [],
    });
    const names = (await vendo.actions.descriptors()).map((descriptor) => descriptor.name);
    expect(names.some((name) => name.endsWith("_SEND_THING"))).toBe(false);
    expect(await vendo.connections.catalog()).toEqual([]);
  });

  it("named services with no Cloud key refuse by NAMING the fix, never silently", async () => {
    // RED: return plain `unconfiguredConnections()` and the message stops
    // naming the services the host asked for.
    vi.stubEnv("VENDO_API_KEY", "");
    const vendo = createVendo({
      models: { default: {} as LanguageModel },
      principal: async () => principal,
      store: await tempStore("vendo-coherence-nokey-"),
      connectedAccounts: ["gmail", "slack"],
    });
    expect(vendo.connections.posture).toBe(false);
    await expect(vendo.connections.initiate(principal, { toolkit: "gmail" }))
      .rejects.toThrow(/VENDO_API_KEY[\s\S]*composioConnector/);
    await expect(vendo.connections.initiate(principal, { toolkit: "gmail" }))
      .rejects.toThrow(/connectedAccounts: \["gmail", "slack"\]/);
  });
});

describe("removed keys refuse to compose, naming their replacement", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["policy", { policy: "cautious" }, /guard\(\{ policy \}\)/],
    ["judge", { judge: {} }, /guard\(\{ judge \}\)/],
    ["approvals", { approvals: { parkedCallTtlMs: 1 } }, /guard\(\{ approvals \}\)/],
    ["brief", { brief: "prose" }, /`instructions`/],
    ["connectorApps", { connectorApps: ["gmail"] }, /connectedAccounts: \["gmail", "slack"\]/],
    ["the agent knobs bag", { agent: { maxSteps: 5 } }, /harness: vendo\(\{ maxSteps \}\)/],
  ];
  for (const [name, extra, message] of cases) {
    it(`${name} throws instead of being dropped`, () => {
      // A JavaScript host gets no type error, and a dropped `policy` would mean
      // an unconfigured guard running wide open. Loud, or not at all.
      expect(() => createVendo({
        models: { default: {} as LanguageModel },
        principal: async () => principal,
        ...extra,
      } as unknown as Parameters<typeof createVendo>[0])).toThrow(message);
    });
  }
});

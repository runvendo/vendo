/**
 * `claudeCode()` through the REAL composition — wave 2 lane E's acceptance half
 * that a unit test cannot reach.
 *
 * `harness-wire.test.ts` proves the composed path with SCRIPTED harnesses on
 * purpose (a model would make it measure a provider). This file is the opposite
 * trade, and it is gated on `ANTHROPIC_API_KEY` so CI never pays it: one real
 * `claudeCode()` turn through `createVendo` → `vendo.handler` → the store, so
 * three things stop being inference and become facts:
 *
 *   - the composed slot actually drives the Agent SDK (E1);
 *   - `audit ⊇ transcript` holds on a claudeCode run (E7 — `audit-superset.e2e.test.ts`
 *     is the bar, and a guarded call made from inside a box has to clear it);
 *   - `turn.state` is DURABLE across turns through the store, not a process-lifetime
 *     map, and a HARNESS SWAP mid-conversation continues the thread from our
 *     transcript rather than restarting it (§1.3).
 *
 * `machine: "local"` because the box leg is proven separately
 * (`packages/harnesses/src/claude-code/claude-code-box.live.test.ts`, and
 * end-to-end over a public tunnel in
 * `docs/verification/door-ctx/live-door-proof.mjs`) and adds a provider account
 * to a test whose subject is composition.
 *
 * **door-ctx.** The harness's tools are the host's own MCP door now, so a
 * composed `claudeCode()` needs one open and an origin the SDK subprocess can
 * resolve. On the local leg that is a LOOPBACK listener — the subprocess runs on
 * this machine, so `http://127.0.0.1:<port>` is a real, reachable, and entirely
 * un-mocked origin. The tool call below therefore travels a genuine HTTP MCP
 * round trip into `vendo.handler`, exactly as the box's does over the internet.
 *
 * **door-internal.** Not one composition here passes `mcp`. That option means
 * "my users may connect third-party agents to my product" and these hosts never
 * said it; naming `claudeCode()` is the whole ask, and composition answers with
 * the internal half of the door. So this file now exercises the DEFAULT
 * `claudeCode()` path rather than a door the host had to open by hand.
 */
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel, UIMessage } from "ai";
import type { Principal, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { claudeCode } from "@vendoai/harnesses/claude-code";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "./server.js";

const live = process.env["ANTHROPIC_API_KEY"] === undefined ? describe.skip : describe;
const MODEL = process.env["VENDO_LIVE_MODEL"] ?? "claude-sonnet-4-5";

const principal: Principal = { kind: "user", subject: "user_claude_composed" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-cc-composed-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const userMessage = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

const post = (path: string, body: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function hostTools(): { tools: ToolRegistry; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const descriptor: ToolDescriptor = {
    name: "maple_invoices_list",
    title: "List invoices",
    description: "List the signed-in customer's invoices",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  };
  return {
    calls,
    tools: {
      async descriptors() { return [descriptor]; },
      async execute(call) {
        calls.push((call.args ?? {}) as Record<string, unknown>);
        return { status: "ok", output: { invoices: [{ id: "inv_1" }, { id: "inv_2" }] } };
      },
    },
  };
}

/**
 * Serve one composed host on loopback, so the SDK subprocess this test starts
 * can reach its MCP door for real. Torn down with the test's other cleanups.
 */
async function listen(vendo: Vendo, origin: string): Promise<void> {
  const port = Number(new URL(origin).port);
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers: Array<[string, string]> = Object.entries(req.headers)
      .flatMap(([key, value]) => (value === undefined
        ? []
        : [[key, Array.isArray(value) ? value.join(",") : value] as [string, string]]));
    const answer = await vendo.handler(new Request(`${origin}${req.url ?? "/"}`, {
      method: req.method,
      headers,
      ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
    }));
    res.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanups.push(async () => {
    // `close()` alone waits for every keep-alive socket, and the SDK subprocess
    // holds its MCP connection open — the teardown then hangs until vitest's
    // hook timeout and the test is reported failed after it already passed.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
}

/** One loopback port per composed host in this file. */
let nextPort = 8830;
const nextOrigin = (): string => `http://127.0.0.1:${(nextPort += 1)}`;

async function compose(overrides: Record<string, unknown> = {}): Promise<{
  vendo: Vendo;
  store: VendoStore;
  host: ReturnType<typeof hostTools>;
  origin: string;
}> {
  const store = await tempStore();
  const host = hostTools();
  const origin = nextOrigin();
  // The harness reaches its tools over THIS door (10-mcp §3b) — the INTERNAL
  // one composition mounts for it, with no `mcp` option anywhere. The operator
  // base is how a deployment names an origin its thinker can dial.
  vi.stubEnv("VENDO_BASE_URL", origin);
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    ...overrides,
  } as Parameters<typeof createVendo>[0]);
  vendo.actions.add(host.tools);
  await listen(vendo, origin);
  return { vendo, store, host, origin };
}

const auditRows = async (store: VendoStore): Promise<Array<Record<string, unknown>>> => {
  const { records } = await store.records("vendo_audit").list({ refs: { subject: principal.subject } });
  return records.map((record) => record.data as Record<string, unknown>);
};

live("claudeCode() through createVendo", () => {
  it("E1/E7 · serves a real turn, runs a guarded call, and keeps audit ⊇ transcript", async () => {
    const { vendo, store, host } = await compose({
      harness: claudeCode({ machine: "local", model: MODEL, maxTurns: 10 }),
    });

    const turn = await vendo.handler(post("/threads", {
      threadId: "thr_cc",
      message: userMessage("m1", "How many invoices are open? Just tell me the number."),
    }));
    expect(turn.status).toBe(200);
    const wire = await turn.text();
    console.log("[composed turn]", JSON.stringify({ wire: wire.slice(0, 1200), calls: host.calls }));

    // The composed slot drove the real SDK, and the guarded call executed on OUR
    // side — the box (here, the local machine) never touches the world.
    expect(host.calls).toHaveLength(1);

    const fetched = await vendo.handler(new Request("https://host.test/api/vendo/threads/thr_cc"));
    const thread = await fetched.json() as { messages: Array<{ role: string; parts: Array<{ type: string }> }> };
    expect(thread.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    // E7's bar: every guarded call that reached the TRANSCRIPT has an audit row,
    // and the audit plane additionally carries what the transcript never does.
    const rows = await auditRows(store);
    const toolRows = rows.filter((row) => row["kind"] === "tool-call");
    const transcriptToolParts = thread.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "dynamic-tool" || part.type.startsWith("tool-"));
    console.log("[composed audit]", JSON.stringify({
      kinds: rows.map((row) => row["kind"]),
      toolRows: toolRows.length,
      transcriptToolParts: transcriptToolParts.length,
    }));
    expect(toolRows.length).toBeGreaterThanOrEqual(transcriptToolParts.length);
    expect(transcriptToolParts.length).toBeGreaterThan(0);
    // Metering rides the audit plane ONLY, so billing never reads the story layer.
    const runRow = rows.find((row) => row["kind"] === "run");
    expect((runRow?.["detail"] as { usage?: unknown } | undefined)?.usage).toBeDefined();
    expect(JSON.stringify(thread.messages)).not.toContain("inputTokens");
  }, 420_000);

  it("door-internal · ZERO CONFIG: no `mcp`, no base URL, and the agent still runs the product's tools", async () => {
    // The headline this lane exists for. Everything a host writes is here:
    // `createVendo({ harness: claudeCode({ machine: "local" }) })`. No `mcp`,
    // no `oauth`, no `VENDO_BASE_URL`. Composition mounts the internal door and
    // the host learns its own origin from the request that arrives — so the
    // turn is driven over the REAL loopback URL, not through `vendo.handler`,
    // because the origin the wire is reached at is the whole mechanism.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VENDO_BASE_URL", "");
    const store = await tempStore();
    const host = hostTools();
    const origin = nextOrigin();
    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      store,
      harness: claudeCode({ machine: "local", model: MODEL, maxTurns: 10 }),
      // NODE_ENV=development also arms source capture, which is unrelated.
      development: false,
    } as Parameters<typeof createVendo>[0]);
    vendo.actions.add(host.tools);
    await listen(vendo, origin);

    const answered = await fetch(`${origin}/api/vendo/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thr_zero_config",
        message: userMessage("m1", "How many invoices are open? Just tell me the number."),
      }),
    });
    expect(answered.status).toBe(200);
    const wire = await answered.text();
    console.log("[zero-config turn]", JSON.stringify({ wire: wire.slice(0, 1200), calls: host.calls }));

    // The tool really executed host-side, over a door nobody configured.
    expect(host.calls).toHaveLength(1);
    // And no outsider could have reached it: the same origin serves no
    // discovery at all.
    const card = await fetch(`${origin}/.well-known/mcp/server-card.json`);
    expect(card.status).toBe(404);
    const bare = await fetch(`${origin}/api/vendo/mcp`, { method: "POST" });
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toBeNull();
  }, 420_000);

  it("door-ctx · a guard DENIAL travels the door and is NARRATED, never crashed", async () => {
    // Moved here from `claude-code.live.test.ts` when the tools became the
    // door's: a denial now arrives as the MCP tool's in-band error text rather
    // than the SDK's native `{behavior:"deny"}`, and the point of the proof is
    // that the model still explains and stops instead of treating it as a bug.
    const store = await tempStore();
    const origin = nextOrigin();
    const calls: string[] = [];
    vi.stubEnv("VENDO_BASE_URL", origin);
    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      store,
      harness: claudeCode({ machine: "local", model: MODEL, maxTurns: 8 }),
    } as Parameters<typeof createVendo>[0]);
    vendo.actions.add({
      async descriptors() {
        return [{
          name: "maple_invoices_pay",
          title: "Pay an invoice",
          description: "Pay one of the signed-in customer's invoices.",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          risk: "read",
        }] as ToolDescriptor[];
      },
      async execute(call) {
        calls.push(call.tool);
        return {
          status: "blocked",
          reason: "That payment needs the person's approval before it can go through.",
        };
      },
    } as ToolRegistry);
    await listen(vendo, origin);

    const response = await vendo.handler(post("/threads", {
      threadId: "thr_denied",
      message: userMessage("m1", "Please pay invoice inv_1 now."),
    }));
    const text = await response.text();
    console.log("[composed denial]", JSON.stringify({ calls, tail: text.slice(-800) }));

    // It really reached our guard-bound registry, over the door.
    expect(calls).toContain("maple_invoices_pay");
    // ...and the model narrated the refusal rather than reporting a failure.
    expect(text.toLowerCase()).toMatch(/approv|permission|confirm/);
  }, 420_000);

  /**
   * These last two compose with NO listener and NO operator base, so the
   * internal door composition mounts has no origin the subprocess could dial.
   * That is not a misconfiguration and must not refuse the turn: a local
   * thinker with no origin is a workspace-only assistant, and these two prove
   * it still thinks. (The BOX leg's refusal for the same missing origin is
   * pinned offline in `claude-code.test.ts`; the local half can only be proven
   * here, because a local-leg unit test would have to run the real SDK.)
   */
  it("§1.3 · turn.state is DURABLE: a second composition on the same store resumes the session", async () => {
    const store = await tempStore();
    const runTurn = async (id: string, text: string): Promise<string> => {
      // A FRESH createVendo each turn — the process-lifetime map this replaced
      // would hand turn 2 a blank slate and pay a re-seed every single time.
      const host = hostTools();
      const vendo = createVendo({
        model: {} as LanguageModel,
        principal: async () => principal,
        store,
        harness: claudeCode({ machine: "local", model: MODEL, maxTurns: 6 }),
      } as Parameters<typeof createVendo>[0]);
      vendo.actions.add(host.tools);
      const response = await vendo.handler(post("/threads", {
        threadId: "thr_durable",
        message: userMessage(id, text),
      }));
      return await response.text();
    };

    await runTurn("m1", "Remember the number 5591. Just say ok.");
    const stored = await store.records("vendo_state").list({});
    console.log("[composed state]", JSON.stringify(stored.records.map((record) => record.id)));
    // No new table: the state rides vendo_state under a namespaced app id.
    expect(stored.records.some((record) => String(record.id).includes("harness_state:thr_durable"))).toBe(true);

    const second = await runTurn("m2", "What number did I ask you to remember? Reply with digits only.");
    console.log("[composed resume]", JSON.stringify({ tail: second.slice(-600) }));
    expect(second).toContain("5591");
  }, 600_000);

  it("§1.3 · a mid-conversation SWAP continues the thread from our transcript", async () => {
    const store = await tempStore();
    const host = hostTools();
    // Turn 1 answered by a DIFFERENT thinker, which is what makes turn 2 a swap:
    // the state slot belongs to another harness, so §1.3 clears it and the
    // re-seed has to come from the transcript we own.
    const other = createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      store,
      harness: defineHarness({
        name: "scripted",
        async *run() {
          yield { type: "text", delta: "Your favourite colour is teal. Noted." };
        },
      }) as never,
    } as Parameters<typeof createVendo>[0]);
    other.actions.add(host.tools);
    await other.handler(post("/threads", {
      threadId: "thr_swap",
      message: userMessage("m1", "My favourite colour is teal. Remember it."),
    }));

    const swapped = createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      store,
      harness: claudeCode({ machine: "local", model: MODEL, maxTurns: 6 }),
    } as Parameters<typeof createVendo>[0]);
    swapped.actions.add(hostTools().tools);
    const response = await swapped.handler(post("/threads", {
      threadId: "thr_swap",
      message: userMessage("m2", "What is my favourite colour? One word."),
    }));
    const text = await response.text();
    console.log("[composed swap]", JSON.stringify({ tail: text.slice(-600) }));
    expect(text.toLowerCase()).toContain("teal");
  }, 420_000);
});

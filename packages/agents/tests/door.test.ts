/**
 * THE TOOL DOOR, both ends, no stub between them.
 *
 * `claudeCode()` declares `requires: { toolDoor: true }` and this package never
 * filled the slot, so a boxed agent booted with the model's own hands and NONE
 * of the host's tools — silently, because the harness's warning is gated on a
 * door port existing at all. Anything that mocks one side of that reproduces
 * the bug with a green suite, so the seam is driven whole here: the REAL
 * `agent()`, the REAL `claudeCode()` driver, the REAL box control-port wire
 * (`@vendoai/apps/box-door`), the REAL MCP door this package mounts, and the
 * REAL `createClaudeSession` the box hands the credential to. The two things
 * scripted are the ones a unit test genuinely cannot run: the e2b provider and
 * the Agent SDK.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxAdapter } from "@vendoai/apps";
// The REAL box door and the REAL in-box session opener, over a fake transport:
// what the box does with `toolDoor` is the other half of this seam.
import { createSessionRoutes } from "@vendoai/apps/box-door";
import { createClaudeSession, VENDO_MCP_SERVER } from "@vendoai/apps/claude-turn";
import { harnessAdapters } from "@vendoai/harnesses";
import { createStore } from "@vendoai/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent } from "../src/agent.js";
import { DOOR_PATH } from "../src/door.js";
import { claudeCode } from "../src/harnesses.js";
import { tool } from "../src/tools.js";

const ORIGIN = "https://app.example.com";
const DOOR_URL = `${ORIGIN}${DOOR_PATH}`;

let stores = 0;
const memoryStore = () => createStore({ dataDir: `memory://agents-door-${stores++}` });

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const boxRoots: string[] = [];

/** What the box saw, and what it did with it. */
interface BoxRun {
  toolDoor?: { url: string; token: string };
  emit: (event: Record<string, unknown>) => void;
}

/**
 * A stand-in for the PROVIDER, not for our code: `create()` records the spec the
 * egress boundary lands in, and `request()` is a transport adapter over the
 * actual box control port, so the payload the script reads is the payload the
 * real box would read.
 */
function fakeSandbox(script: (box: BoxRun) => Promise<void>) {
  const created: Array<{ allowedDomains?: string[] }> = [];
  const adapter: SandboxAdapter = {
    async create(spec) {
      created.push(spec as { allowedDomains?: string[] });
      const root = mkdtempSync(path.join(tmpdir(), "agents-fakebox-"));
      boxRoots.push(root);
      const routes = createSessionRoutes({
        root,
        // A created machine boots with no token: create-time envs never reach a
        // template's start command, so the first hello claims it.
        token: "",
        env: {},
        openSession: (input: BoxRun) => ({
          async send() {
            await script({
              ...(input.toolDoor === undefined ? {} : { toolDoor: input.toolDoor }),
              emit: input.emit,
            });
          },
          async interrupt() {},
          async end() {},
        }),
      }) as {
        handle: (
          method: string,
          pathname: string,
          headers: Record<string, string>,
          payload: unknown,
        ) => Promise<{ status: number; body: unknown }>;
      };
      return {
        id: `box_${created.length}`,
        async request(req) {
          const body = req.body === undefined
            ? {}
            : JSON.parse(typeof req.body === "string" ? req.body : decoder.decode(req.body)) as unknown;
          const answer = await routes.handle(
            req.method,
            req.path,
            (req.headers ?? {}) as Record<string, string>,
            body,
          );
          return { status: answer.status, headers: {}, body: encoder.encode(JSON.stringify(answer.body)) };
        },
        url: async () => "http://box",
        snapshot: async () => "fake:snap",
        stop: async () => {},
        destroy: async () => {},
      };
    },
    resume: async () => {
      throw new Error("a conversation box is destroyed, never resumed");
    },
    destroy: async () => {},
  };
  return { adapter, created };
}

/** One raw MCP request over the door's fetch handler: initialize when no session
 *  id is given, tools/list once there is one. */
const mcpRequest = (token: string, sessionId?: string) =>
  new Request(DOOR_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      ...(sessionId === undefined
        ? {
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "box", version: "0" } },
        }
        : { method: "tools/list", params: {} }),
    }),
  });

/** The transport answers Streamable HTTP; the payload rides one SSE data line. */
const jsonRpcBody = async (response: Response): Promise<string> => response.text();

const refund = tool({
  name: "refund_invoice",
  risk: "write",
  inputSchema: { type: "object" as const },
  execute: () => ({ ok: true }),
});

beforeEach(() => {
  // The ladder and the egress skin both read the environment; pin it so a
  // developer's own keys cannot decide what this suite measures.
  vi.stubEnv("VENDO_BASE_URL", "");
  vi.stubEnv("VENDO_API_KEY", "");
  vi.stubEnv("E2B_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of boxRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the door ladder", () => {
  it("an explicit `door: { baseUrl }` beats VENDO_BASE_URL", () => {
    vi.stubEnv("VENDO_BASE_URL", "https://env.example.com");
    const harness = claudeCode({ machine: "local" });
    agent({ name: "support", harness, store: memoryStore(), door: { baseUrl: ORIGIN } });
    expect(harnessAdapters(harness).toolDoor?.url).toBe(DOOR_URL);
  });

  it("VENDO_BASE_URL fills the slot the host left unset", () => {
    vi.stubEnv("VENDO_BASE_URL", ORIGIN);
    const harness = claudeCode({ machine: "local" });
    agent({ name: "support", harness, store: memoryStore() });
    expect(harnessAdapters(harness).toolDoor?.url).toBe(DOOR_URL);
  });

  it("a SANDBOXED harness with neither is a BOOT error naming both ways out — never a turn that dies in front of a user", () => {
    const { adapter } = fakeSandbox(async () => {});
    expect(() => agent({ name: "support", harness: claudeCode(), store: memoryStore(), sandbox: adapter }))
      .toThrow(/door: \{ baseUrl/);
    expect(() => agent({ name: "support", harness: claudeCode(), store: memoryStore(), sandbox: adapter }))
      .toThrow(/VENDO_BASE_URL/);
  });

  it("machine \"local\" with neither serves its own door on loopback — a subprocess can always dial 127.0.0.1", async () => {
    const harness = claudeCode({ machine: "local" });
    const support = agent({ name: "support", harness, store: memoryStore(), tools: [refund] });
    // `session()` awaits the bind, so by the time any turn reads the URL it is real.
    await support.session("u_42");
    const url = harnessAdapters(harness).toolDoor?.url;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/vendo\/mcp$/);
    // A REAL listener answers, and it is the INTERNAL door: no credential, no way in.
    const answer = await fetch(url!, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(answer.status).toBe(401);
  });

  it("mounts on the BOXED leg too — `requires.sandbox` is not what decides this", () => {
    const harness = claudeCode();
    const { adapter } = fakeSandbox(async () => {});
    agent({ name: "support", harness, store: memoryStore(), sandbox: adapter, door: { baseUrl: ORIGIN } });
    expect(harnessAdapters(harness).toolDoor?.url).toBe(DOOR_URL);
  });

  it("a harness that thinks in this process is handed no door and needs no origin", () => {
    const harness = claudeCode({ machine: "local" });
    const support = agent({ name: "support", harness, store: memoryStore(), door: { baseUrl: ORIGIN } });
    expect(support.door).toBeTypeOf("function");
    const { adapter } = fakeSandbox(async () => {});
    const plain = agent({
      name: "plain",
      harness: { name: "inert", async *run() {} } as never,
      store: memoryStore(),
      sandbox: adapter,
    });
    expect(plain.door).toBeUndefined();
  });
});

describe("what the box is actually handed", () => {
  it("dials the door, lists the host's tools through it, and carries its hostname out of the box", async () => {
    let seen: BoxRun["toolDoor"];
    let listing = "";
    let initialized = 0;
    const { adapter, created } = fakeSandbox(async (box) => {
      seen = box.toolDoor;
      if (box.toolDoor !== undefined) {
        // THE DIAL-BACK, for real: the credential the harness minted, presented
        // to the handler this agent handed the host, while the turn is live.
        const open = await support.door!(mcpRequest(box.toolDoor.token));
        initialized = open.status;
        const sessionId = open.headers.get("mcp-session-id");
        if (sessionId !== null) {
          listing = await jsonRpcBody(await support.door!(mcpRequest(box.toolDoor.token, sessionId)));
        }
      }
      box.emit({ type: "text", delta: "done" });
    });
    const support = agent({
      name: "support",
      harness: claudeCode(),
      store: memoryStore(),
      tools: [refund],
      sandbox: adapter,
      door: { baseUrl: ORIGIN },
    });
    const session = await support.session("u_42");
    await (await session.stream("refund invoice 7")).text();

    // (1) A real port produced a real credential and a real URL.
    expect(seen?.url).toBe(DOOR_URL);
    expect(seen?.token).toMatch(/^vtk_/);

    // (2) The `liveTurn` seam is wired, so that credential RESOLVES: publishing
    //     is the only thing that turns a minted pointer into a live turn.
    expect(initialized).toBe(200);
    expect(listing).toContain("refund_invoice");

    // (3) The door's hostname is on the box's outbound allowlist — a box that
    //     cannot reach the door has the tools and cannot call them.
    expect(created[0]?.allowedDomains).toContain("app.example.com");
  });

  it("that same credential is what becomes the SDK's `mcpServers` entry", async () => {
    let handed: BoxRun["toolDoor"];
    const { adapter } = fakeSandbox(async (box) => {
      handed = box.toolDoor;
      box.emit({ type: "text", delta: "done" });
    });
    const support = agent({
      name: "support",
      harness: claudeCode(),
      store: memoryStore(),
      tools: [refund],
      sandbox: adapter,
      door: { baseUrl: ORIGIN },
    });
    await (await (await support.session("u_42")).stream("hi")).text();
    expect(handed).toBeDefined();

    // The box's own last step, run for real over a scripted SDK: `claudeTurn`
    // is where a `toolDoor` becomes a remote MCP server the model can call.
    const opened: Array<Record<string, unknown>> = [];
    const session = createClaudeSession({
      cwd: "/box/user",
      env: {},
      emit: () => {},
      toolDoor: handed!,
      sdk: {
        query: (params: { options: Record<string, unknown>; prompt: AsyncIterable<unknown> }) => {
          opened.push(params.options);
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "system", subtype: "init", session_id: "sess_1" };
              for await (const _message of params.prompt) {
                yield { type: "result", subtype: "success", session_id: "sess_1", usage: {} };
              }
            },
          };
        },
      } as never,
    });
    await session.send("hi");
    await session.end();
    expect(opened[0]?.["mcpServers"]).toEqual({
      [VENDO_MCP_SERVER]: {
        type: "http",
        url: DOOR_URL,
        headers: { Authorization: `Bearer ${handed!.token}` },
        alwaysLoad: true,
      },
    });
  });

  it("between turns the credential points at nothing — the door answers 401", async () => {
    let token = "";
    const { adapter } = fakeSandbox(async (box) => {
      token = box.toolDoor?.token ?? "";
      box.emit({ type: "text", delta: "done" });
    });
    const support = agent({
      name: "support",
      harness: claudeCode(),
      store: memoryStore(),
      tools: [refund],
      sandbox: adapter,
      door: { baseUrl: ORIGIN },
    });
    await (await (await support.session("u_42")).stream("hi")).text();
    expect(token).toMatch(/^vtk_/);
    expect((await support.door!(mcpRequest(token))).status).toBe(401);
  });
});

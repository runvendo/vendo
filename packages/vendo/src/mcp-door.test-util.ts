/**
 * ONE composed host serving BOTH doors, plus a minimal streamable-HTTP MCP
 * client — shared by the parity gate and the outside-agent pin so the two files
 * can never drift into measuring different things.
 *
 * Extracted verbatim from `mcp-door-parity.e2e.test.ts` (cc-native lane) when
 * the door-ctx lane needed a SECOND file driving the same door: the pin has to
 * exercise the identical client, or "the outside-agent path did not change"
 * would only be a claim about two different clients.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractedTool } from "@vendoai/actions";
import type { AuditEvent, Principal, ToolDescriptor, ToolRegistry, ToolResult } from "@vendoai/core";
import { defineHarness, harnessAdapters } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { createVendo, type Vendo } from "./server.js";

export const SUBJECT = "user_parity";
export const principal: Principal = { kind: "user", subject: SUBJECT };
export const READ_TOOL = "host_lookup";
export const WRITE_TOOL = "host_pay";

export const MOUNT = "https://host.test/api/vendo/mcp";
const REDIRECT = "https://client.example/callback";
const VERIFIER = "a-very-long-pkce-verifier-that-is-valid-for-the-parity-gate-1234567890";

/** Registered by each spec file's own `afterEach`, so a temp store never leaks. */
export const cleanups: Array<() => Promise<void>> = [];

export async function runCleanups(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-parity-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** One read the `cautious` policy runs silently, one write it parks for a human. */
export function hostTools(): ToolRegistry {
  const descriptors: ToolDescriptor[] = [
    {
      name: READ_TOOL,
      title: "Look something up",
      description: "Look something up for the signed-in customer",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      risk: "read",
    },
    {
      name: WRITE_TOOL,
      title: "Send a payment",
      description: "Send a payment to a payee",
      inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
      risk: "write",
    },
  ];
  return {
    async descriptors() {
      return descriptors;
    },
    async execute() {
      return { status: "ok", output: { ok: true } };
    },
  };
}

export interface Row {
  id: string;
  kind: string;
  tool?: string;
  outcome?: string;
  decidedBy?: string;
  venue?: string;
  presence?: string;
  turnId?: string;
  principal?: { subject?: string };
}

/**
 * The audit rows one tool left behind, of one KIND.
 *
 * `tool-call` is the executed-call ledger. `approval` is the OTHER ledger, and
 * it is the only one an UNATTENDED run writes: nothing executes, so the truth
 * about who asked, from where, and whether anyone was watching lives there.
 */
export const toolRows = async (
  store: VendoStore,
  tool: string,
  kind: "tool-call" | "approval" = "tool-call",
): Promise<Row[]> => {
  const { records } = await store.records("vendo_audit").list({ refs: { subject: SUBJECT } });
  return records
    .map((record) => record.data as unknown as AuditEvent as unknown as Row)
    .filter((row) => row.kind === kind && row.tool === tool);
};

/**
 * The rows one leg of the gate added. Row ORDER out of the store is not the order
 * they were written, so the two legs are separated by identity, never by `at(-1)`.
 */
export async function rowsAddedBy(
  store: VendoStore,
  tool: string,
  leg: () => Promise<unknown>,
  kind: "tool-call" | "approval" = "tool-call",
): Promise<Row[]> {
  const before = new Set((await toolRows(store, tool, kind)).map((row) => row.id));
  await leg();
  return (await toolRows(store, tool, kind)).filter((row) => !before.has(row.id));
}

/** The five fields the contract names, as one comparable shape. */
export const shapeOf = (row: Row | undefined): Record<string, unknown> => ({
  outcome: row?.outcome,
  decidedBy: row?.decidedBy,
  presence: row?.presence,
  venue: row?.venue,
  subject: row?.principal?.subject,
});

export interface ComposedHost {
  vendo: Vendo;
  store: VendoStore;
  observed: string[];
  /** The `turn.turnId` of every turn the probe harness ran, in order — the join
   *  key contract §3.5 puts on audit rows, read from the harness that owned it. */
  turnIds: string[];
}

/**
 * A model that answers every generation prompt with one valid screen, so a
 * `vendo_make` call reaches a REAL receipt instead of the no-model failure path.
 *
 * Local rather than `@vendoai/apps`' `scriptedLanguageModel` because `testing/`
 * is not on that package's exports map; same shape as the other fixture doubles
 * in this package (`inclient.fixture.test.ts`, `pins.fixture.test.ts`).
 */
export const SCREEN_TITLE = "Spending this month";
const SCREEN = `<App name="${SCREEN_TITLE}"><Text text="Ready"/><Disclaimer reason="Fixture app."/></App>`;

export const screenModel = (): LanguageModel => {
  const answer = {
    content: [{ type: "text" as const, text: SCREEN }],
    finishReason: "stop" as const,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
  return {
    specificationVersion: "v2",
    provider: "vendo-parity-screen",
    modelId: "vendo-parity-screen-v1",
    supportedUrls: {},
    async doGenerate() {
      return answer;
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text_1" });
            controller.enqueue({ type: "text-delta", id: "text_1", delta: SCREEN });
            controller.enqueue({ type: "text-end", id: "text_1" });
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
};

/**
 * ONE composed host serving BOTH doors: a `claudeCode()`-shaped harness turn on
 * the chat wire, and the MCP door at its canonical mount.
 */
export async function composedHost(
  script: (call: (tool: string, args: unknown) => Promise<ToolResult>) => Promise<void>,
  model?: LanguageModel,
): Promise<ComposedHost> {
  const store = await tempStore();
  const observed: string[] = [];
  const turnIds: string[] = [];
  const harness = defineHarness({
    name: "parity-probe",
    async *run(turn) {
      turnIds.push(turn.turnId);
      await script(async (tool, args) => {
        const result = await turn.tools.call(tool, args as never);
        observed.push(`${tool}:${result.status}`);
        return result;
      });
      yield { type: "text", delta: "done" };
    },
  });
  const vendo = createVendo({
    model: model ?? ({} as LanguageModel),
    principal: async () => principal,
    store,
    guard: { policy: "cautious" },
    harness: harness as never,
    mcp: true,
    oauth: {
      async authorize() {
        return { subject: SUBJECT };
      },
      async principal(subject) {
        return { kind: "user", subject };
      },
    },
  } as Parameters<typeof createVendo>[0]);
  vendo.actions.add(hostTools());
  await store.ensureSchema();
  return { vendo, store, observed, turnIds };
}

/**
 * The SAME composed host, but the probe harness reaches its tools THROUGH the
 * door with a minted turn credential — which is exactly what a `claudeCode()`
 * box does over native remote MCP, minus the network hop.
 *
 * `vendo.handler` is the door's real fetch-style entry point, so nothing here is
 * a shortcut: the request carries a Bearer, opens an MCP session, and speaks
 * JSON-RPC. The only thing the box adds on top is HTTPS.
 */
export async function composedHostOverDoor(
  script: (door: DoorSession, mint: () => string | undefined) => Promise<void>,
  /** Extracted host tools (`.vendo/tools.json` shape) to compose IN ADDITION to
   *  the two registry tools — the only way to drive the extraction → registry →
   *  door plumbing from here. Left out, the host is exactly what it always was. */
  extracted?: ExtractedTool[],
  model?: LanguageModel,
): Promise<ComposedHost> {
  const store = await tempStore();
  const observed: string[] = [];
  const turnIds: string[] = [];
  let composed: Vendo;
  const harness = defineHarness({
    name: "door-probe",
    async *run(turn) {
      turnIds.push(turn.turnId);
      const port = harnessAdapters(harness).toolDoor;
      if (port === undefined) throw new Error("composition did not provide a tool door");
      const mint = (): string | undefined => port.mint(turn.threadId as string);
      const token = mint();
      if (token === undefined) throw new Error("no credential could be minted inside a live turn");
      const session = await openDoor(composed, token);
      observed.push(`minted:${token.slice(0, 4)}`);
      await script(session, mint);
      yield { type: "text", delta: "done" };
    },
  });
  composed = createVendo({
    model: model ?? ({} as LanguageModel),
    principal: async () => principal,
    store,
    guard: { policy: "cautious" },
    harness: harness as never,
    mcp: true,
    ...(extracted === undefined ? {} : { tools: extracted }),
    oauth: {
      async authorize() {
        return { subject: SUBJECT };
      },
      async principal(subject) {
        return { kind: "user", subject };
      },
    },
  } as Parameters<typeof createVendo>[0]);
  composed.actions.add(hostTools());
  await store.ensureSchema();
  return { vendo: composed, store, observed, turnIds };
}

/** The chat wire's own turn — the in-process path. Returns the raw UI-message
 *  stream, so a caller can read the RUNTIME's mirror parts off it. */
export async function runHarnessTurn(vendo: Vendo, threadId: string, text: string): Promise<string> {
  const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId,
      message: { id: `m_${threadId}`, role: "user", parts: [{ type: "text", text }] },
    }),
  }));
  if (response.status !== 200) throw new Error(`turn failed ${response.status}: ${await response.text()}`);
  // Drain the stream: the turn only completes as the body is consumed.
  return response.text();
}

/**
 * The tool-call MIRROR the runtime wrote onto one turn's stream (§1.5: "tool
 * calls are mirrored by the runtime, never yielded"), as `chunk:toolName`.
 *
 * This is the TRANSCRIPT half of parity — what the user's screen and the stored
 * thread saw — as opposed to the audit row, which is what the ledger saw. Names
 * are correlated through `toolCallId` because only the opening chunk carries one.
 */
export function mirroredToolParts(stream: string): string[] {
  const names = new Map<string, string>();
  const seen: string[] = [];
  for (const line of stream.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let part: { type?: string; toolCallId?: string; toolName?: string };
    try {
      part = JSON.parse(line.slice(6)) as typeof part;
    } catch {
      continue;
    }
    if (typeof part.type !== "string" || !part.type.startsWith("tool-")) continue;
    if (typeof part.toolCallId === "string" && typeof part.toolName === "string") {
      names.set(part.toolCallId, part.toolName);
    }
    const named = part.toolCallId === undefined ? undefined : names.get(part.toolCallId);
    seen.push(`${part.type}:${named ?? "?"}`);
  }
  return seen;
}


/**
 * An UNATTENDED turn on the same host — the shape an automation fires with
 * (`presence: "away"`, `venue: "automation"`). Driven through `vendo.harness`,
 * the handle composition exposes for exactly this, because the chat wire always
 * mints `presence: "present"` (`wire/context.ts`) and can never produce one.
 */
export async function runUnattendedTurn(vendo: Vendo, threadId: string, text: string): Promise<string> {
  const response = await vendo.harness.stream({
    threadId,
    message: { id: `m_${threadId}`, role: "user", parts: [{ type: "text", text }] },
    ctx: {
      principal,
      venue: "automation",
      presence: "away",
      sessionId: `session_${threadId}`,
    },
  });
  if (response.status !== 200) throw new Error(`unattended turn failed ${response.status}`);
  return response.text();
}

/** The user's tap over the public wire, polled because the turn blocks on it. */
export async function tapWhenItAppears(vendo: Vendo, tool: string, approve: boolean): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const listed = await vendo.handler(new Request("https://host.test/api/vendo/approvals"));
    if (listed.ok) {
      const pending = (await listed.json()) as Array<{ id: string; call?: { tool?: string } }>;
      const mine = pending.find((request) => request.call?.tool === tool);
      if (mine !== undefined) {
        const decided = await vendo.handler(new Request("https://host.test/api/vendo/approvals/decide", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: [mine.id], decision: { approve } }),
        }));
        if (!decided.ok) throw new Error(`decide failed ${decided.status}`);
        return mine.id;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no approval was ever parked for ${tool}`);
}

// ── the MCP door's client side ────────────────────────────────────────────────

const pkce = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/** register → authorize → token. The ONLY way an OUTSIDE agent's bearer exists. */
export async function bearer(vendo: Vendo): Promise<string> {
  const registered = await vendo.handler(new Request(`${MOUNT}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "parity gate", redirect_uris: [REDIRECT], scope: "read write" }),
  }));
  const { client_id: clientId } = (await registered.json()) as { client_id: string };

  const authorized = await vendo.handler(new Request(`${MOUNT}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: pkce(VERIFIER),
    code_challenge_method: "S256",
    scope: "read write",
    resource: MOUNT,
  })}`));
  const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;

  const issued = await vendo.handler(new Request(`${MOUNT}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
      code,
      client_id: clientId,
      code_verifier: VERIFIER,
      resource: MOUNT,
    }),
  }));
  if (issued.status !== 200) throw new Error(`token failed ${issued.status}: ${await issued.text()}`);
  return ((await issued.json()) as { access_token: string }).access_token;
}

export interface DoorSession {
  listTools(): Promise<Array<{ name: string; description?: string; annotations?: unknown; outputSchema?: unknown }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }>;
}

/** A minimal streamable-HTTP MCP client: initialize, then tools/list or tools/call. */
export async function openDoor(vendo: Vendo, token: string): Promise<DoorSession> {
  let id = 0;
  let sessionId: string | undefined;
  const rpc = async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
    id += 1;
    const response = await vendo.handler(new Request(MOUNT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
    }));
    const learned = response.headers.get("mcp-session-id");
    if (learned !== null) sessionId = learned;
    const body = await response.text();
    // The door answers JSON-RPC over SSE frames; take the last data line.
    const line = body.split("\n").filter((raw) => raw.startsWith("data:")).at(-1);
    const payload = JSON.parse(line === undefined ? body : line.slice(5).trim()) as
      { result?: Record<string, unknown>; error?: { message?: string } };
    if (payload.error !== undefined) throw new Error(`door ${method} failed: ${payload.error.message}`);
    return payload.result ?? {};
  };

  await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "parity-gate", version: "1.0.0" },
  });
  await vendo.handler(new Request(MOUNT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }));

  return {
    async listTools() {
      const result = await rpc("tools/list");
      return (result["tools"] as Awaited<ReturnType<DoorSession["listTools"]>>) ?? [];
    },
    async callTool(name, args) {
      const result = await rpc("tools/call", { name, arguments: args });
      const content = (result["content"] as Array<{ text?: string }> | undefined) ?? [];
      return {
        ...(result["isError"] === true ? { isError: true } : {}),
        text: content.map((part) => part.text ?? "").join(""),
      };
    },
  };
}

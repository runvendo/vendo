/** The cross-block INTEGRATION harness. Unlike every other fixture suite (which
 * hand-composes the blocks "the way the umbrella will"), this one boots the REAL
 * composed umbrella — `createVendo` from `@vendoai/vendo/server` — and drives
 * whole-product journeys through the PUBLIC WIRE over real HTTP.
 *
 * What a stack is:
 *   - a per-test PGlite store in a temp dir (isolation),
 *   - `createVendo({ model, principal, store, actAs, policy })` — nothing else is
 *     hand-wired; store/guard/actions/apps/automations are composed by the umbrella,
 *   - host tools loaded through the real `.vendo/tools.json` contract (createVendo
 *     does `createActions({ dir: "." })` from cwd = this package),
 *   - the umbrella `handler` served on a loopback node:http server (the wire),
 *   - `VENDO_BASE_URL` pointed at the booted fixture host app so route bindings
 *     execute real HTTP there (trusted-origin branch → present credentials forward).
 *
 * The only sanctioned NON-wire seams tests may touch: `vendo.emit` (host-event) and
 * `stack.sql` (raw SQL over the public vendo_* tables for side-effect asserts). The
 * harness itself also reads `vendo.store`. Journeys otherwise use the wire only.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vitest";
import { zipSync } from "fflate";
import type { Connector } from "@vendoai/actions";
import type { SandboxAdapter } from "@vendoai/apps";
import type { AppDocument, Principal, ToolRegistry } from "@vendoai/core";
import { createMcpDoor, type AppsPort, type HostOAuthAdapter, type McpDoor } from "@vendoai/mcp";
import { createStore, type VendoStore } from "@vendoai/store";
import { createVendo, type CreateVendoConfig, type Vendo } from "@vendoai/vendo/server";
import {
  scriptedModel,
  textTurn,
  toolCallTurn,
  ZERO_USAGE,
  type LanguageModelV3Prompt,
  type LanguageModelV3StreamPart,
  type ScriptedModel,
  type ScriptedTurn,
} from "@vendoai-fixtures/test-kit/stream-turns";
import type { LanguageModel } from "ai";

export const fixtureBaseUrl = (): string => inject("fixtureBaseUrl");

/** Next's dev server may reset a socket while lazily compiling a fixture
 * route. Retry transport failures only so HTTP failures remain assertions. */
export async function fixtureFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError;
}

/** Seeded fixture principals — resolved from the `x-vendo-test-user` header. */
export const ADA: Principal = { kind: "user", subject: "user_ada" };
export const BOB: Principal = { kind: "user", subject: "user_bob" };

export const WIRE_BASE = "/api/vendo";

// ---------------------------------------------------------------------------
// Scripted LanguageModel — the chat-e2e technique, now shared with every other
// suite that scripts a model (`@vendoai-fixtures/test-kit/stream-turns`).
// Re-exported here so
// this harness stays the single import every journey in this package reaches
// for.
// ---------------------------------------------------------------------------

export {
  scriptedModel,
  textTurn,
  toolCallTurn,
  ZERO_USAGE,
  type LanguageModelV3Prompt,
  type LanguageModelV3StreamPart,
  type ScriptedModel,
  type ScriptedTurn,
};

/** A generation-engine turn: the apps engine reads this through doGenerate and
 * parses the emitted text as CREATE/EDIT-dialect JSON. Pass the object; it is
 * serialized verbatim so the dialect must be VALID (an invalid one triggers the
 * engine's internal repair retry, which would consume the next scripted turn). */
export function generationTurn(dialect: unknown, id = "gen_1"): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: typeof dialect === "string" ? dialect : JSON.stringify(dialect) },
    { type: "text-end", id },
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
  ];
}

/**
 * The AI reviewer's verdict on one finished screen — a `report_findings` strict
 * tool call over `doGenerate` (`packages/apps/src/checking/strict-tool-call.ts`),
 * empty by default because "nothing wrong" is what a fixture app deserves.
 *
 * Scripted as the call it really is rather than left to run the script dry:
 * `strictToolCall` swallows every failure into "no findings", so an unscripted
 * reviewer passes for the wrong reason AND eats the turn the caller after it was
 * waiting for.
 */
export function reviewerTurn(
  findings: ReadonlyArray<{ severity: "block" | "warn"; where: string; message: string }> = [],
  toolCallId = "screen_review",
): LanguageModelV3StreamPart[] {
  return toolCallTurn("report_findings", { findings }, toolCallId);
}

/**
 * The screen agent's turns for one `vendo_make` ask: save the whole document
 * with its own hands, stop, and then face the reviewer. A CREATE and an EDIT are
 * the same loop — an edit is the assembler opening this app's own document and
 * saving it back — so one helper scripts either.
 *
 * Every `vendo_make` ask starts in the assembly loop now — that used to be
 * behind `apps.experimentalScreenAgent` and the flag is gone — so a script that
 * only feeds the conductor's generation turns runs the assembly loop out of
 * answers and then feeds ITS turns to the conductor, one call out of step.
 * Written as one helper rather than three lines per fixture because the three
 * are one thing: "the screen agent answered this ask".
 *
 * The reviewer turn is part of that one thing because the pass is MANDATORY: a
 * screen that PAINTED faces it once at the finish line whether or not the loop
 * called `validate` itself (`screen-agent.ts`'s mandatory reviewer pass). A save
 * the floor blocks never paints, so that ask leaves this turn unspent — an
 * unused turn costs a script nothing, and a missing one costs it the next call.
 */
export function screenAgentCreateTurns(dialect: string): LanguageModelV3StreamPart[][] {
  return [
    toolCallTurn("save_app", { content: dialect }, "screen_save"),
    textTurn("saved", "screen_done"),
    reviewerTurn(),
  ];
}

/** The app id the composed server put in the prompt it just sent, if any. */
export function appIdInPrompt(prompt: LanguageModelV3Prompt): string {
  const found = /app_[0-9a-f-]{8,}/.exec(JSON.stringify(prompt));
  if (found === null) throw new Error("no app id in the prompt the model was handed");
  return found[0];
}

// ---------------------------------------------------------------------------
// Host-app helpers (fixture login / reset / away identity).
// ---------------------------------------------------------------------------

const cookieCache = new Map<string, string>();

export async function loginCookie(subject: string): Promise<string> {
  const cached = cookieCache.get(subject);
  if (cached !== undefined) return cached;
  // The shared Next dev fixture can reset its first login socket while sibling
  // Turbo tasks finish compiling; fixtureFetch retries only transport failures.
  const response = await fixtureFetch(`${fixtureBaseUrl()}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: subject }),
  });
  if (!response.ok) throw new Error(`Fixture login failed (${response.status})`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Fixture login did not return a cookie");
  cookieCache.set(subject, cookie);
  return cookie;
}

export async function resetFixture(): Promise<void> {
  const response = await fixtureFetch(`${fixtureBaseUrl()}/fixture/reset`, { method: "POST" });
  if (!response.ok) throw new Error(`Fixture reset failed (${response.status})`);
}

/** Away identity: host-implemented ActAs — a fixture login for the grant's
 * subject. Used by the away (automation) journeys in later lanes; present chat
 * calls authenticate by forwarding the wire request's own cookie instead. */
const fixtureActAs = async (principal: Principal): Promise<{ headers: Record<string, string> }> => ({
  headers: { cookie: await loginCookie(principal.subject) },
});

/** A direct host-app fetch (bypasses the wire) for asserting real host state. */
export async function hostFetch(path: string, subject: string, init: RequestInit = {}): Promise<Response> {
  return fixtureFetch(`${fixtureBaseUrl()}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: await loginCookie(subject) },
  });
}

// ---------------------------------------------------------------------------
// The stack — one real composed umbrella served on a loopback wire server.
// ---------------------------------------------------------------------------

export interface StackOptions {
  /** Ordered scripted turns consumed by doStream (agent) + doGenerate (engine). */
  turns?: readonly ScriptedTurn[];
  model?: LanguageModel;
  /** Mount the MCP door (J6) beside `vendo.handler` on the same loopback origin,
   * composed from the umbrella's OWN parts — the way a host must today until the
   * `createVendo({ mcp: true })` hookup lands (docs/contracts/10-mcp-umbrella-hookup.md). */
  mcp?: boolean;
  /** Compose the umbrella with `telemetry: true` (opt-in anonymous telemetry).
   * Consent is still resolved at emit time from env/config (J11). */
  telemetry?: boolean;
  /** Back the composed store with real Postgres (createStore({ url })) instead of
   * the default per-test PGlite temp dir. Used by the J9 durability journey. */
  storeUrl?: string;
  /** External connectors composed into the umbrella (04-actions §3) — the
   * connected-accounts journeys pass a composioConnector aimed at a stub. */
  connectors?: Connector[];
  /** A sandbox adapter composed into the umbrella (explicit adapter always
   * wins, the adapter rule) — the machine-skin journey passes a fake box. */
  sandbox?: SandboxAdapter;
  /** `createVendo({ tools })` — the third-party install story: capability
   * authored outside `packages/` arrives as plain tool definitions on the same
   * key the host's own declarations use. */
  tools?: CreateVendoConfig["tools"];
  /** `createVendo({ skills })` — SKILL.md values mounted at /host/skills. */
  skills?: CreateVendoConfig["skills"];
  /** `createVendo({ apps: { checks } })` — checks appended to the floor. */
  checks?: NonNullable<Exclude<CreateVendoConfig["apps"], false>>["checks"];
  /** `createVendo({ catalog })` — host components generated apps may render. */
  catalog?: CreateVendoConfig["catalog"];
  /** `createVendo({ apps: false })` — app generation unmounted entirely. */
  apps?: false;
  /** `createVendo({ profileDir })` — the `.vendo` config root. Either the host
   * root or the `.vendo` directory itself; the external-pack journey passes both
   * forms to prove the boot gates resolve it the way the registry does. */
  profileDir?: string;
  /** `createVendo({ development })` — the composition-time opt-in that mounts
   * the development-only seams (`/dev/*`, `POST /sync/impact`). Absent leaves
   * them unmounted, which is what a default stack asserts. */
  development?: boolean;
}

/** The door mounted alongside the wire when `createStack({ mcp: true })`. */
export interface McpDoorHandle {
  /** The shared loopback origin (identical to `stack.baseUrl`). */
  origin: string;
  /** The door mount — `${origin}/api/vendo/mcp` (the MCP Streamable HTTP endpoint). */
  endpoint: string;
  /** The SAME guard-bound registry the door serves — `vendo.guard.bind(vendo.actions)`;
   * used to assert `tools/list` descriptors match the registry verbatim. */
  bound: ToolRegistry;
  /** Live door controls: which fixture subject the OAuth adapter authorizes as, and
   * the revoked-subject set (`principal() → null` kills a session, 10-mcp §3). */
  control: { autoSubject?: string; revoked: Set<string> };
}

export interface Stack {
  /** The wire origin (loopback). Wire calls go to `${baseUrl}${WIRE_BASE}/...`. */
  baseUrl: string;
  vendo: Vendo;
  model: ScriptedModel;
  /** Present only when created with `{ mcp: true }` — the co-mounted MCP door. */
  mcp?: McpDoorHandle;
  /** A wire request as `user`: sets x-vendo-test-user (principal) + the host
   * session cookie (so present route bindings authenticate) + JSON content-type. */
  wireFetch(path: string, init?: RequestInit, user?: Principal): Promise<Response>;
  /** Raw SQL over the composed store — the public vendo_* side-effect asserts. */
  sql<Row = Record<string, unknown>>(query: string, params?: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

export async function createStack(options: StackOptions = {}): Promise<Stack> {
  // Route bindings resolve against the host app; an explicit VENDO_BASE_URL is the
  // trusted-origin branch, so present-call credentials forward there. Set BEFORE
  // createVendo reads it. VENDO_TICK_SECRET is set for the later scheduler lane.
  process.env.VENDO_BASE_URL = fixtureBaseUrl();
  process.env.VENDO_TICK_SECRET ??= "integration-tick-secret";

  const dataDir = await mkdtemp(join(tmpdir(), "vendo-integration-"));
  const store = options.storeUrl === undefined
    ? createStore({ dataDir })
    : createStore({ url: options.storeUrl });
  // Open the DB up front so `store.raw()` (the SQL-assert seam) is usable
  // immediately; createVendo also calls ensureSchema (idempotent).
  await store.ensureSchema();
  const model = (options.model as ScriptedModel | undefined) ?? scriptedModel(options.turns ?? []);

  const vendo = createVendo({
    model,
    principal: async (req) => {
      const subject = req.headers.get("x-vendo-test-user");
      return subject ? { kind: "user", subject } : null;
    },
    store,
    actAs: fixtureActAs,
    guard: { policy: { file: ".vendo/policy.json" } },
    ...(options.telemetry === true ? { telemetry: true } : {}),
    ...(options.connectors === undefined ? {} : { connectors: options.connectors }),
    // A configured sandbox IS the opt-in to machine-backed execution; a stack
    // composed WITH one is here to exercise the box machinery.
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    apps: options.apps === false ? false : {
      ...(options.checks === undefined ? {} : { checks: options.checks }),
    },
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    ...(options.profileDir === undefined ? {} : { profileDir: options.profileDir }),
    ...(options.development === undefined ? {} : { development: options.development }),
  });

  // J6 — the MCP door, composed from the umbrella's OWN parts (the hookup note's
  // exact shape). Same guard, same store, same guard-bound registry chat uses:
  // one perimeter, one approvals/audit plane. The `oauth` seam is the fixture
  // host's login (authorize resolves the current fixture subject; principal()
  // resolution IS revocation, 10-mcp §3).
  let door: McpDoor | undefined;
  let mcpControl: McpDoorHandle["control"] | undefined;
  let mcpBound: ToolRegistry | undefined;
  if (options.mcp === true) {
    const control: McpDoorHandle["control"] = { autoSubject: ADA.subject, revoked: new Set<string>() };
    mcpControl = control;
    mcpBound = vendo.guard.bind(vendo.actions);
    const oauth: HostOAuthAdapter = {
      async authorize() {
        if (control.autoSubject === undefined) return new Response("missing fixture session", { status: 401 });
        return { subject: control.autoSubject };
      },
      async principal(subject) {
        return control.revoked.has(subject) ? null : { kind: "user", subject };
      },
    };
    // AppsPort adapter over vendo.apps — AppsRuntime.open has extra "resuming"
    // and "failed" variants AppsPort does not, so map positively like the
    // production adapter in @vendoai/vendo server.ts (the door is a viewer +
    // runner, 10-mcp §4).
    const appsPort: AppsPort = {
      list: (ctx) => vendo.apps.list(ctx),
      async open(appId, ctx) {
        const opened = await vendo.apps.open(appId, ctx);
        if (opened.kind === "tree") return { kind: "tree", payload: opened.payload };
        if (opened.kind === "http") return { kind: "http", url: opened.url };
        throw new Error(`app surface "${opened.kind}" is unreachable for the door viewer role`);
      },
      call: (appId, ref, args, ctx) => vendo.apps.call(appId, ref, args, ctx),
    };
    door = createMcpDoor({ tools: mcpBound, guard: vendo.guard, store, oauth, apps: appsPort });
  }

  // The door serves its own mount (/api/vendo/mcp…) and the origin-root discovery
  // documents (/.well-known/…); everything else is the umbrella wire. Route by
  // path so both share one loopback origin (10-mcp-umbrella-hookup §4).
  const httpServer = createServer((req, res) => {
    const path = (req.url ?? "/").split("?", 1)[0] ?? "/";
    const toDoor = door !== undefined
      && (path === "/api/vendo/mcp" || path.startsWith("/api/vendo/mcp/") || path.startsWith("/.well-known/"));
    void forwardToWire(req, res, toDoor ? door!.handler : vendo.handler);
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("wire server did not bind a TCP port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const raw = store.raw() as { query(q: string, p?: unknown[]): Promise<{ rows: unknown[] }> };

  const mcp: McpDoorHandle | undefined = door === undefined || mcpControl === undefined || mcpBound === undefined
    ? undefined
    : { origin: baseUrl, endpoint: `${baseUrl}/api/vendo/mcp`, bound: mcpBound, control: mcpControl };

  return {
    baseUrl,
    vendo,
    model,
    ...(mcp === undefined ? {} : { mcp }),
    async wireFetch(path, init = {}, user) {
      const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
      const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes((init.method ?? "GET").toUpperCase());
      if (mutation && headers["content-type"] === undefined && path !== "/apps/import") {
        headers["content-type"] = "application/json";
      }
      if (user !== undefined) {
        headers["x-vendo-test-user"] = user.subject;
        // Forward the host session cookie so PRESENT route bindings authenticate
        // against the host app (04 §4 trusted-origin forwarding).
        headers.cookie = await loginCookie(user.subject);
      }
      return fixtureFetch(`${baseUrl}${WIRE_BASE}${path}`, { ...init, headers });
    },
    async sql(query, params) {
      return (await raw.query(query, params)).rows as never;
    },
    async close() {
      // The data dir goes in a finally: a server that refuses to close, or a
      // PGlite close that rejects, must not strand the scratch directory —
      // that is what grew /tmp by one dir per stack for every red run.
      try {
        await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
        await store.close();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  };
}

async function forwardToWire(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const host = req.headers.host ?? "127.0.0.1";
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
    const request = new Request(`http://${host}${req.url ?? "/"}`, {
      method: req.method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const response = await handler(request);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    // STREAM the body through as it arrives — buffering it whole via
    // `arrayBuffer()` (the old shape) meant no real HTTP client could ever
    // observe a still-open SSE turn's early chunks (the approval/connect
    // cards §1.4 writes BEFORE a blocked call resolves); the whole response
    // only ever reached the wire once the turn was completely finished.
    if (response.body === null) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end(error instanceof Error ? error.message : "wire bridge failed");
  }
}

// ---------------------------------------------------------------------------
// SSE draining — the ai-SDK UI message stream the /threads route returns.
// ---------------------------------------------------------------------------

export interface StreamRead {
  parts: Array<Record<string, unknown>>;
  raw: string;
}

export async function readSse(response: Response): Promise<StreamRead> {
  const raw = await response.text();
  const parts = raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
    .map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>);
  return { parts, raw };
}

export function partsOfType(read: StreamRead, type: string): Array<Record<string, unknown>> {
  return read.parts.filter((part) => part.type === type);
}

/** The core approvalId (apr_...) surfaced beside the native tool part on the
 * stream (the ai-SDK data-part envelope carries fields under `data`). */
export function vendoApprovalId(read: StreamRead): string {
  const part = partsOfType(read, "data-vendo-approval")[0];
  if (part === undefined) throw new Error("stream carried no data-vendo-approval part");
  const id = (part.data as { approvalId?: unknown }).approvalId;
  if (typeof id !== "string") throw new Error("data-vendo-approval part carried no approvalId");
  return id;
}

// ---------------------------------------------------------------------------
// Mid-stream approval sync (build contract §1.4): an interactive harness turn
// BLOCKS INSIDE the guarded call awaiting the tap, holding the SAME request
// open rather than parking the turn for a client-driven resume (the pre-flip
// `createAgent` shape, native `tool-approval-request` + a re-posted thread —
// gone from this wire). A test that needs to decide, or merely observe, an
// approval while its turn is still in flight reads the open response
// progressively instead of draining it first.
// ---------------------------------------------------------------------------

/** The `data-vendo-approval` wire part's payload (01-core §16). */
export interface VendoApprovalWireData {
  toolCallId: string;
  risk: string;
  approvalId?: string;
  invalidatedGrant?: { id: string; grantedAt: string };
}

export interface MidStreamRead {
  /** Resolves with the approval card's data the MOMENT it lands on the wire —
   *  before the turn itself completes. The synchronization point a test acts
   *  on: decide the approval, or just read pending state, while the guarded
   *  call is still blocked awaiting it. */
  approval: Promise<VendoApprovalWireData>;
  /** Resolves with the fully drained stream once the turn ends: decided,
   *  denied, or timed out at the frozen `APPROVAL_WAIT_MS` bound. */
  done: Promise<StreamRead>;
}

/** Read a still-open `/threads` SSE response, exposing the approval card as
 *  soon as it arrives rather than only once the whole turn finishes. */
export function readSseMidStream(response: Response): MidStreamRead {
  let resolveApproval!: (data: VendoApprovalWireData) => void;
  const approval = new Promise<VendoApprovalWireData>((resolve) => {
    resolveApproval = resolve;
  });
  const done = (async (): Promise<StreamRead> => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let raw = "";
    const parts: Array<Record<string, unknown>> = [];
    let notified = false;
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buffer += chunk;
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
        const part = JSON.parse(trimmed.slice("data: ".length)) as Record<string, unknown>;
        parts.push(part);
        if (!notified && part.type === "data-vendo-approval") {
          notified = true;
          resolveApproval(part.data as VendoApprovalWireData);
        }
      }
    }
    return { parts, raw };
  })();
  return { approval, done };
}

// ---------------------------------------------------------------------------
// Automation-journey helpers (J4/J5): .vendoapp import over the wire, approval
// decisions, and run polling with a deadline. createVendo takes no `now`, so the
// schedule leg is driven with a PAST `at` that is due on the first /tick.
// ---------------------------------------------------------------------------

/** An ApprovalRequest as it crosses the wire (enable's `missing[]`, GET /approvals). */
export interface WireApproval {
  id: string;
  call: { tool: string };
}

/** The RunRecord shape the /runs wire returns (07 §5), narrowed to the asserts. */
export interface WireRun {
  id: string;
  appId: string;
  status: "running" | "ok" | "error" | "stopped" | "pending-approval";
  steps: Array<{ id: string; tool: string; outcome: string; detail?: string }>;
  summary?: string;
  error?: { code: string; message: string };
}

/** Build a `.vendoapp` archive (app.json only — no machine) from an AppDocument.
 * The import boundary re-mints the id and re-validates the document (06 §7). */
export function buildVendoApp(doc: AppDocument): Uint8Array {
  return zipSync({ "app.json": new TextEncoder().encode(JSON.stringify(doc)) }, { level: 6 });
}

/** Import an automation through the PUBLIC wire (POST /apps/import,
 * application/octet-stream). Returns the imported (fresh-id) document. */
export async function importAutomation(stack: Stack, doc: AppDocument, user: Principal): Promise<AppDocument> {
  const response = await stack.wireFetch("/apps/import", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: buildVendoApp(doc),
  }, user);
  if (!response.ok) throw new Error(`import failed (${response.status}): ${await response.text()}`);
  return (await response.json()) as AppDocument;
}

/** Decide a batch of approvals over the wire (POST /approvals/decide). */
export async function decideApprovals(
  stack: Stack,
  ids: string[],
  decision: Record<string, unknown>,
  user: Principal,
): Promise<Response> {
  return stack.wireFetch("/approvals/decide", {
    method: "POST",
    body: JSON.stringify({ ids, decision }),
  }, user);
}

/** Poll GET /runs/:id until it reaches `status` or the deadline passes. Away runs
 * resume asynchronously (guard.onApprovalDecision), so callers poll; the deadline
 * tolerates CI-grade slowness. */
export async function waitForRunStatus(
  stack: Stack,
  runId: string,
  user: Principal,
  status: WireRun["status"],
  timeoutMs = 30_000,
): Promise<WireRun> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() <= deadline) {
    const response = await stack.wireFetch(`/runs/${runId}`, {}, user);
    if (response.ok) {
      const run = (await response.json()) as WireRun;
      last = run.status;
      if (run.status === status) return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`run ${runId} did not reach ${status}; last status was ${last ?? "unknown"}`);
}

/** An ISO timestamp an hour in the past — a due `at` schedule that fires on the
 * first /tick after enable (the deterministic public-wire way to drive a schedule
 * trigger without clock injection). */
export function pastAtIso(): string {
  return new Date(Date.now() - 3_600_000).toISOString();
}

/** The red-team mini-umbrella harness: a superset of the wave-4 automations
 * harness that composes the SAME real blocks (real PGlite store, real guard,
 * real actions against the live fixture host app, real apps runtime, real
 * automations engine) and then hands adversarial suites the extra primitives
 * they need to attack the composed system — away contexts, forged artifacts,
 * tampered .vendoapp bytes, and the run-token proxy surface.
 *
 * Everything the automations harness exported is re-exported here unchanged so
 * suites can `import { ... } from "./harness.js"` exactly as they would there.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vitest";
import { unzipSync, zipSync, type Unzipped, type Zippable } from "fflate";
import type {
  ActAs,
  AgentRunner,
  AppDocument,
  AppId,
  Principal,
  RunContext,
  ToolRegistry,
  Trigger,
} from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { createGuard, type Judge, type PolicyConfig, type VendoGuard } from "@vendoai/guard";
import { createActions } from "@vendoai/actions";
import { createApps, type AppsRuntime, type SandboxAdapter } from "@vendoai/apps";
import { createAutomations, type AutomationsEngine } from "@vendoai/automations";

export const fixtureBaseUrl = (): string => inject("fixtureBaseUrl");

/** Seeded fixture principals. Owned here (not in support.js) so both the
 * harness helpers and the support helpers can share one definition. */
export const ADA: Principal = { kind: "user", subject: "user_ada" };
export const BOB: Principal = { kind: "user", subject: "user_bob" };

/** Egress test constants — a domain the app should never be allowed to reach,
 * and one an egress allowlist would legitimately permit. */
export const EVIL_DOMAIN = "evil.example.com";
export const ALLOWED_DOMAIN = "api.allowed.test";

/** The fixture's host tool surface, declared inline (same set the wave-3
 * actions e2e and wave-4 automations e2e used) — includes a critical:true tool
 * so critical-confirmation abuse can be exercised end to end. */
export const hostTools = [
  {
    name: "host_invoices_list",
    description: "List invoices",
    inputSchema: { type: "object" },
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
  },
  {
    name: "host_invoices_create",
    description: "Create invoice",
    inputSchema: { type: "object" },
    risk: "write",
    binding: { kind: "route", method: "POST", path: "/api/invoices", argsIn: "body" },
  },
  {
    name: "host_invoices_get",
    description: "Get invoice",
    inputSchema: { type: "object" },
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/api/invoices/{id}", argsIn: "query" },
  },
  {
    name: "host_invoices_update",
    description: "Update invoice",
    inputSchema: { type: "object" },
    risk: "write",
    binding: { kind: "route", method: "PATCH", path: "/api/invoices/{id}", argsIn: "body" },
  },
  {
    name: "host_invoices_send",
    description: "Send invoice",
    inputSchema: { type: "object" },
    risk: "write",
    binding: { kind: "route", method: "POST", path: "/api/invoices/{id}/send", argsIn: "body" },
  },
  {
    name: "host_invoices_send_critical",
    description: "Send invoice with critical confirmation",
    inputSchema: { type: "object" },
    risk: "write",
    critical: true,
    binding: { kind: "route", method: "POST", path: "/api/invoices/{id}/send", argsIn: "body" },
  },
] as const;

export async function loginCookie(subject: string): Promise<string> {
  const response = await fetch(`${fixtureBaseUrl()}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: subject }),
  });
  if (response.status !== 200) throw new Error(`Fixture login failed (${response.status})`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Fixture login did not return a cookie");
  return cookie;
}

export async function resetFixture(): Promise<void> {
  const response = await fetch(`${fixtureBaseUrl()}/fixture/reset`, { method: "POST" });
  if (response.status !== 200) throw new Error(`Fixture reset failed (${response.status})`);
}

/** Away identity: the host-implemented ActAs — here, a fixture login for the
 * grant's subject. Called by actions when a call carries presence "away". */
export const fixtureActAs: ActAs = async (principal) => {
  const cookie = await loginCookie(principal.subject);
  return { headers: { cookie } };
};

export interface Stack {
  store: VendoStore;
  guard: VendoGuard;
  bound: ToolRegistry;
  apps: AppsRuntime;
  automations: AutomationsEngine;
  /** Writes an owned app row (subject + doc, enabled=false) the way the apps
   * lifecycle would, without needing a generation model. */
  putApp(subject: string, doc: AppDocument): Promise<void>;
  /** Raw SQL against the real store — the brief's vendo_* table asserts. */
  sql<Row = Record<string, unknown>>(query: string, params?: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

export interface StackOptions {
  runner?: AgentRunner;
  /** Build the runner from the stack's own parts — the live leg builds
   *  agent.asRunner() over the same guard + bound registry. Wins over runner. */
  runnerFrom?: (parts: { guard: VendoGuard; bound: ToolRegistry; store: VendoStore }) => AgentRunner;
  now?: () => Date;
  policy?: PolicyConfig;
  sandbox?: SandboxAdapter;
  /** Guard LLM judge — passed straight to createGuard so judge-posture suites
   *  can exercise the composed system's ask/block decisions (ENG-251). */
  judge?: Judge;
  /** Guard circuit breakers (rate / write caps) — passed to createGuard so
   *  breaker-abuse suites can drive the composed system (ENG-251). */
  breakers?: { maxCallsPerMinute?: number; maxWritesPerRun?: number };
}

export async function createStack(options: StackOptions = {}): Promise<Stack> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-redteam-e2e-"));
  const store = createStore({ dataDir });
  await store.ensureSchema();
  const guard = createGuard({
    store,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.judge === undefined ? {} : { judge: options.judge }),
    ...(options.breakers === undefined ? {} : { breakers: options.breakers }),
  });
  const actions = createActions({
    tools: hostTools as unknown as Parameters<typeof createActions>[0]["tools"],
    baseUrl: fixtureBaseUrl(),
    actAs: fixtureActAs,
  });
  const bound = guard.bind(actions);
  const apps = createApps({
    store,
    guard,
    tools: bound,
    catalog: [],
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
  });
  const runner = options.runnerFrom === undefined
    ? options.runner
    : options.runnerFrom({ guard, bound, store });
  const automations = createAutomations({
    apps,
    tools: bound,
    guard,
    store,
    ...(runner === undefined ? {} : { runner }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    store,
    guard,
    bound,
    apps,
    automations,
    async putApp(subject, doc) {
      await store.records("vendo_apps").put({
        id: doc.id,
        data: { subject, enabled: false, doc },
        refs: { subject },
      });
    },
    async sql(query, params) {
      const raw = store.raw() as { query(q: string, p?: unknown[]): Promise<{ rows: unknown[] }> };
      const result = await raw.query(query, params);
      return result.rows as never;
    },
    async close() {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export function automationDoc(input: {
  id: AppId;
  name?: string;
  trigger: Trigger;
}): AppDocument {
  return {
    format: "vendo/app@1",
    id: input.id,
    name: input.name ?? input.id,
    trigger: input.trigger,
  };
}

export function ownerCtx(subject: string, appId?: AppId): RunContext {
  const principal: Principal = { kind: "user", subject };
  return {
    principal,
    venue: "chat",
    presence: "present",
    sessionId: `sess_${subject}`,
    ...(appId === undefined ? {} : { appId }),
  };
}

// --- Red-team primitives -------------------------------------------------

/** An away-run context: presence "away", venue "automation", a bound appId, and
 * a schedule trigger ref — the shape actions/automations produce for an
 * unattended run. Away-park / away-bypass suites drive calls through this so
 * the actAs seam (not present header forwarding) is what authenticates. */
export function awayCtx(subject: string, appId: AppId): RunContext {
  const principal: Principal = { kind: "user", subject };
  return {
    principal,
    venue: "automation",
    presence: "away",
    sessionId: `sess_away_${subject}`,
    appId,
    trigger: { runId: `run_${subject}_${Date.now()}`, kind: "schedule" },
  };
}

/** Overrides for {@link craftAppDocument}: any AppDocument field plus arbitrary
 * attacker-controlled extras (passthrough schemas accept unknown keys). */
export type CraftedAppOverrides = Partial<AppDocument> & Record<string, unknown>;

/** Forge an AppDocument with a caller-chosen id and arbitrary attacker
 * fields (forkedFrom, egress, secrets, pins, trigger, storage, server, tree,
 * …) merged in. Used to feed malicious artifacts straight into importApp /
 * putApp so suites can prove the block re-mints ids, strips server refs, and
 * rejects forged surfaces. */
export function craftAppDocument(overrides: CraftedAppOverrides = {}): AppDocument {
  return {
    format: "vendo/app@1",
    id: "app_forged",
    name: "forged",
    ...overrides,
  } as AppDocument;
}

/** Import a forged AppDocument object directly (no zip): the source-is-an-object
 * branch of importApp. Returns the imported (re-minted, sanitized) document. */
export async function importDoc(stack: Stack, doc: AppDocument, ctx: RunContext): Promise<AppDocument> {
  return stack.apps.importApp(doc, ctx);
}

/** Export an app to .vendoapp bytes, decode the archive, let `mutate` rewrite
 * the parsed app.json object in place (or return a replacement), then re-zip.
 * The tampered bytes go back through importApp so tests can prove the import
 * boundary re-validates and sanitizes what an attacker put in the archive.
 * Non-app.json entries (the app/ machine files) are preserved verbatim. */
export async function exportAndTamper(
  stack: Stack,
  appId: AppId,
  ctx: RunContext,
  mutate: (appJson: Record<string, unknown>) => Record<string, unknown> | void,
): Promise<Uint8Array> {
  const bytes = await stack.apps.exportApp(appId, ctx);
  const archive: Unzipped = unzipSync(bytes);
  const appJsonBytes = archive["app.json"];
  if (appJsonBytes === undefined) throw new Error("exported .vendoapp is missing app.json");
  const appJson = JSON.parse(new TextDecoder().decode(appJsonBytes)) as Record<string, unknown>;
  const mutated = mutate(appJson) ?? appJson;
  const next: Zippable = {};
  for (const [entry, entryBytes] of Object.entries(archive)) {
    if (entry === "app.json") continue;
    next[entry] = entryBytes;
  }
  next["app.json"] = new TextEncoder().encode(JSON.stringify(mutated));
  return zipSync(next, { level: 6 });
}

/** The run-token capability proxy exposed for run-token abuse tests.
 *
 * NOTE ON COUPLING: the token HMAC secret is minted inside createApps() and is
 * never handed out — createAppsProxy, createAppData, mintRunToken and
 * verifyRunToken are all internal to @vendoai/apps and unreachable through its
 * exports map (only ".", "./e2b", "./modal" are exported). So we cannot mint a
 * VALID token from here, and there is no `mintToken`/token-secret to expose.
 * What we CAN reach is the REAL proxy the runtime already built (apps.proxy),
 * which is the higher-value adversarial surface: red-team suites drive forged,
 * malformed, expired, and cross-app bearer tokens at `handler` and assert the
 * proxy rejects them (401/404) without leaking state or executing tools.
 * Positive-path (valid-token) minting is covered block-local in
 * packages/apps/src/run-token.ts + proxy tests. */
export interface RedTeamProxy {
  handler(request: Request): Promise<Response>;
}

export function mkProxy(stack: Stack): RedTeamProxy {
  return { handler: (request) => stack.apps.proxy.handler(request) };
}

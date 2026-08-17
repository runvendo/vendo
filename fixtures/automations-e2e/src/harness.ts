/** The automations harness: composes REAL blocks the way the umbrella does —
 * real PGlite store, real guard, real actions against the live fixture host
 * app, real apps runtime — around @vendoai/automations under test.
 *
 * The unit is the RECORD. An automation is not an app any more: it is a row a
 * principal owns, created through the ONE create operation every authoring door
 * calls, and read back through the engine's own list/get. Suites get that create
 * op, the runner map, fixture reset/login helpers, the seeded host tool surface,
 * an ActAs that logs into the fixture, and raw SQL access (store.raw()) for the
 * vendo_automations / vendo_runs / vendo_grants asserts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vitest";
import { DEFAULT_RUNNER_NAME, serviceToolSlug, USE_SERVICE_TOOL } from "@vendoai/core";
import type {
  ActAs,
  AgentRunner,
  AgentRunners,
  AppDocument,
  AutomationRecord,
  CreateAutomation,
  CreateAutomationInput,
  Principal,
  RiskResolver,
  RunContext,
  ToolRegistry,
} from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { createGuard, type PolicyConfig, type VendoGuard } from "@vendoai/guard";
import { createActions } from "@vendoai/actions";
import { connectorDiscoveryRegistry } from "@vendoai/vendo";
import { createApps, type AppsRuntime, type SandboxAdapter } from "@vendoai/apps";
import {
  automationsInternals,
  createAutomations,
  type AutomationsEngine,
  type ReconcileAutomations,
} from "@vendoai/automations";

export const fixtureBaseUrl = (): string => inject("fixtureBaseUrl");

/** Next's dev server can briefly reset an in-flight socket while compiling a
 * fixture route. Retry transport failures only; HTTP responses stay visible to
 * the calling test. */
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

/** The fixture's host tool surface, declared inline (same set the wave-3
 * actions e2e used) — extraction itself is actions' covered ground; these
 * suites are about automations semantics. */
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
    // Sending reaches a human, so the dev labels it destructive — the label is
    // final (two-vote grading removed), and THE LAW's away-run refusals rest on it.
    risk: "destructive",
    binding: { kind: "route", method: "POST", path: "/api/invoices/{id}/send", argsIn: "body" },
  },
  {
    name: "host_invoices_send_critical",
    description: "Send invoice with critical confirmation",
    inputSchema: { type: "object" },
    risk: "write",
    confirmEach: true,
    binding: { kind: "route", method: "POST", path: "/api/invoices/{id}/send", argsIn: "body" },
  },
] as const;

/** A fixture SERVICE CATALOG — the broker half of connector discovery, with no
 * broker. Three slugs, one per grade the broker's own tags produce, so a suite
 * can drive `use_service_tool` end to end: the dispatcher, the guard's per-call
 * risk resolver, and the audit row's toolkit all read from this one table.
 * Slugs are shaped like the real ones (`TOOLKIT_ACTION`) because the consent
 * copy is derived from that shape. */
export const serviceToolRisks: Record<string, "read" | "write" | "destructive"> = {
  GMAIL_FETCH_EMAILS: "read",
  // Same grade as GMAIL_FETCH_EMAILS on purpose: a suite proving that one
  // service action's grant does not reach another needs a pair the DESCRIPTOR
  // cannot tell apart, or the descriptor hash refuses the call and the slug
  // never has to.
  GMAIL_LIST_LABELS: "read",
  SLACK_SET_STATUS: "write",
  GMAIL_SEND_EMAIL: "destructive",
};

/** Every slug this fixture actually ran, in order — the "nothing happened"
 * assertion for a refusal, and the "it really ran" one for a grant. */
export const serviceToolCalls: Array<{ slug: string; subject: string; args: unknown }> = [];

/** The composition's `resolveRisk`, reproduced exactly: only the dispatcher
 * reaches it, an unknown slug grades `read` (the dispatcher answers "no such
 * tool" without parking a card), and nothing is ever inferred from a name. */
export const serviceToolRiskResolver: RiskResolver = (call) => {
  const slug = serviceToolSlug(call);
  if (call.tool !== USE_SERVICE_TOOL) return undefined;
  return slug === undefined ? undefined : serviceToolRisks[slug] ?? "read";
};

const serviceToolPorts = () => ({
  find: async (need: string) => Object.keys(serviceToolRisks)
    .filter((slug) => slug.toLowerCase().includes(need.toLowerCase()))
    .map((slug) => ({
      slug,
      toolkit: slug.split("_")[0]!.toLowerCase(),
      description: `fixture ${slug}`,
      connected: true,
    })),
  use: async (slug: string, args: unknown, ctx: RunContext) => {
    if (serviceToolRisks[slug] === undefined) return undefined;
    serviceToolCalls.push({ slug, subject: ctx.principal.subject, args });
    return {
      status: "ok" as const,
      output: { ran: slug },
      connectorAccount: { connector: "fixture", toolkit: slug.split("_")[0]!.toLowerCase() },
    };
  },
  list: async () => [{ toolkit: "gmail", connected: true }, { toolkit: "slack", connected: true }],
});

export async function loginCookie(subject: string): Promise<string> {
  const response = await fixtureFetch(`${fixtureBaseUrl()}/api/login`, {
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
  const response = await fixtureFetch(`${fixtureBaseUrl()}/fixture/reset`, { method: "POST" });
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
  /** THE one create operation, reached the way every authoring door reaches it.
   *  It is not public API, so a suite that wants a record uses the same door
   *  `vendo_automate`, `agent.on` and the manifest fold-in use. */
  create: CreateAutomation;
  /** The boot-time runner map. `register` throws on a duplicate name; a
   *  fire-time miss is a FAILED run row, never a fallback brain. */
  runners: AgentRunners;
  /** Applies a `ReconcilePlan` and answers what it did. Deliberately NOT
   *  `automations.disable`: that one stamps `disarmedBy: "user"`, and a redeploy
   *  impersonating a person's kill switch would make the switch unremovable by
   *  the next deploy. Both callers (agent.on's boot, the vendo.json fold-in) go
   *  through here. */
  reconcile: ReconcileAutomations;
  /** Writes an owned app row (subject + doc, enabled=false) the way the apps
   * lifecycle would, without needing a generation model. */
  putApp(subject: string, doc: AppDocument): Promise<void>;
  /** Raw SQL against the real store — the vendo_* table asserts. */
  sql<Row = Record<string, unknown>>(query: string, params?: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

export interface StackOptions {
  /** Registered under DEFAULT_RUNNER_NAME — the composed agent's own slot. */
  runner?: AgentRunner;
  /** Extra brains, by the name a record's `agent` field names. */
  runners?: Record<string, AgentRunner>;
  /** Build the default runner from the stack's own parts — the live leg builds
   *  the `@vendoai/agents` away runner over the same guard and store the engine
   *  got. Wins over runner. */
  runnerFrom?: (parts: { guard: VendoGuard; bound: ToolRegistry; store: VendoStore }) => AgentRunner;
  now?: () => Date;
  policy?: PolicyConfig;
  /** Compose the three connector-discovery tools over the fixture service
   *  catalog above, with the guard and the automations engine sharing one risk
   *  resolver — the way the umbrella composes them. */
  serviceTools?: boolean;
  /** Wrap the guard-bound registry with fixture-local in-process tools (e.g.
   *  a blocking hold tool) AFTER binding — the wrapped extras bypass the
   *  guard on purpose; authority stays under test for the real host tools. */
  wrapTools?: (bound: ToolRegistry) => ToolRegistry;
  /** A v2 box adapter, for suites about MACHINE apps. Composes the apps runtime
   *  with machines enabled and its create seam bound to this stack's own
   *  automations engine — the umbrella's wiring, not a stand-in for it. */
  sandbox?: SandboxAdapter;
}

/**
 * The four-verb seam the apps block may ask of the automations engine, wired to
 * the SAME engine — the umbrella's own wiring, in one place because three stacks
 * here compose it.
 *
 * `resolve` drops an id nothing answers for rather than failing: an app's
 * `automations` list is a list of names, not a foreign key, so a deleted
 * automation is simply one fewer entry the next time the app is read.
 */
export const appsAutomationsSeam = (
  automations: AutomationsEngine,
  create: CreateAutomation,
): NonNullable<Parameters<typeof createApps>[0]["automations"]> => ({
  create,
  enable: automations.enable,
  disable: automations.disable,
  resolve: async (ids, ctx) => {
    const found = await Promise.all(ids.map((id) => automations.get(id, ctx)));
    return found.filter((record): record is AutomationRecord => record !== null);
  },
});

export async function createStack(options: StackOptions = {}): Promise<Stack> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-automations-e2e-"));
  const store = createStore({ dataDir });
  await store.ensureSchema();
  const guard = createGuard({
    store,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.serviceTools === true ? { resolveRisk: serviceToolRiskResolver } : {}),
  });
  const actions = createActions({
    tools: hostTools as unknown as Parameters<typeof createActions>[0]["tools"],
    baseUrl: fixtureBaseUrl(),
    actAs: fixtureActAs,
    fetch: fixtureFetch,
  });
  if (options.serviceTools === true) {
    serviceToolCalls.length = 0;
    actions.add(connectorDiscoveryRegistry(serviceToolPorts()));
  }
  const bound = options.wrapTools === undefined ? guard.bind(actions) : options.wrapTools(guard.bind(actions));
  // `@vendoai/automations` has zero app concepts, so the engine is composed
  // WITHOUT the apps runtime. The dependency runs the other way now: the apps
  // layer holds the create seam, which closes over the engine composed below —
  // creating only ever happens inside a call, which is after createStack
  // returns. The umbrella does exactly this.
  const automations = createAutomations({
    tools: bound,
    guard,
    store,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.serviceTools === true ? { resolveRisk: serviceToolRiskResolver } : {}),
  });
  const internals = automationsInternals(automations);
  const runner = options.runnerFrom === undefined
    ? options.runner
    : options.runnerFrom({ guard, bound, store });
  if (runner !== undefined) internals.runners.register(DEFAULT_RUNNER_NAME, runner);
  for (const [name, named] of Object.entries(options.runners ?? {})) internals.runners.register(name, named);

  const apps = createApps({
    store,
    guard,
    tools: bound,
    catalog: [],
    automations: appsAutomationsSeam(automations, internals.create),
    ...(options.sandbox === undefined ? {} : {
      machine: {
        sandbox: options.sandbox,
        // Idle auto-sleep is irrelevant here; a no-op clock keeps boxes awake.
        clock: { setTimeout: () => 0, clearTimeout: () => undefined },
      },
    }),
  });

  return {
    store,
    guard,
    bound,
    apps,
    automations,
    create: internals.create,
    runners: internals.runners,
    reconcile: internals.reconcile,
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

/** Create a record through the one create door and hand back the record the
 *  engine's own `get` reads back — never the create result alone, so a suite
 *  can never assert about a row that was not actually stored. */
export async function createAutomation(
  stack: Stack,
  input: CreateAutomationInput,
  ctx: RunContext,
): Promise<AutomationRecord> {
  const created = await stack.create(input, ctx);
  const stored = await stack.automations.get(created.id, ctx);
  if (stored === null) throw new Error(`create returned ${created.id} but get read back nothing`);
  return stored;
}

export function ownerCtx(subject: string, appId?: string): RunContext {
  const principal: Principal = { kind: "user", subject };
  return {
    principal,
    venue: "chat",
    presence: "present",
    sessionId: `sess_${subject}`,
    ...(appId === undefined ? {} : { appId }),
  };
}

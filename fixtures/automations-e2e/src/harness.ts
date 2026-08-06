/** The wave-4 automations harness: composes REAL blocks the way the umbrella
 * (09 §2) will — real PGlite store, real guard, real actions against the live
 * fixture host app, real apps runtime — around @vendoai/automations under test.
 *
 * Suites get: a per-test stack factory, fixture reset/login helpers, the
 * seeded host tool surface, an ActAs that logs into the fixture, and raw SQL
 * access (store.raw()) for the vendo_runs / vendo_grants / vendo_approvals
 * asserts the wave brief mandates.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vitest";
import { serviceToolSlug, USE_SERVICE_TOOL } from "@vendoai/core";
import type {
  ActAs,
  AgentRunner,
  AppDocument,
  AppId,
  Principal,
  RiskResolver,
  RunContext,
  ToolRegistry,
  Trigger,
} from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { createGuard, type PolicyConfig, type VendoGuard } from "@vendoai/guard";
import { createActions } from "@vendoai/actions";
import { connectorDiscoveryRegistry } from "@vendoai/agent";
import { createApps, type AppsRuntime, type SandboxAdapter } from "@vendoai/apps";
import { createAutomations, type AutomationsEngine } from "@vendoai/automations";

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
  /** Writes an owned app row (subject + doc, enabled=false) the way the apps
   * lifecycle would, without needing a generation model. */
  putApp(subject: string, doc: AppDocument): Promise<void>;
  /** Raw SQL against the real store — the brief's vendo_* table asserts. */
  sql<Row = Record<string, unknown>>(query: string, params?: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

export interface StackOptions {
  runner?: AgentRunner;
  /** Build the runner from the stack's own parts — the live leg builds the
   *  `@vendoai/agents` away runner over the same guard and store the engine got.
   *  Wins over runner. */
  runnerFrom?: (parts: { guard: VendoGuard; bound: ToolRegistry; store: VendoStore }) => AgentRunner;
  now?: () => Date;
  policy?: PolicyConfig;
  /** Compose the three connector-discovery tools over the fixture service
   *  catalog above, with the guard and the automations engine sharing one risk
   *  resolver — the way the umbrella composes them. */
  serviceTools?: boolean;
  /** Wrap the guard-bound registry with fixture-local in-process tools (e.g.
   *  a blocking hold tool) AFTER binding — the wrapped extras bypass the
   *  guard on purpose; authority stays under test for the real host tools.
   *  (The v1 fn:-step sandbox vehicle died with execution-v2 Wave 1.5; fn
   *  execution returns over the box door with the fn/schedules lane.) */
  wrapTools?: (bound: ToolRegistry) => ToolRegistry;
  /** A v2 box adapter, for suites about MACHINE apps. Composes the apps runtime
   *  with machines enabled and its arming seam bound to this stack's own
   *  automations engine — the umbrella's wiring, not a stand-in for it. */
  sandbox?: SandboxAdapter;
}

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
  // The arming seam closes over the engine composed BELOW: arming only ever
  // happens inside a call, which is after createStack returns — the umbrella
  // does exactly this (`automationsForArming` in packages/vendo/src/server.ts).
  let automationsForArming: AutomationsEngine | undefined;
  const apps = createApps({
    store,
    guard,
    tools: bound,
    catalog: [],
    ...(options.sandbox === undefined ? {} : {
      machine: {
        sandbox: options.sandbox,
        // Idle auto-sleep is irrelevant here; a no-op clock keeps boxes awake.
        clock: { setTimeout: () => 0, clearTimeout: () => undefined },
      },
      armAutomation: async (appId: AppId, triggerId: string, ctx: RunContext) => {
        if (automationsForArming === undefined) throw new Error("arming before the stack was composed");
        return await automationsForArming.enable(appId, triggerId, ctx);
      },
    }),
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
    ...(options.serviceTools === true ? { resolveRisk: serviceToolRiskResolver } : {}),
  });
  automationsForArming = automations;

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

/** An automation document. `trigger` is the one-trigger shorthand every suite
 *  here uses — it lands as the single `main` trigger, which is exactly what a
 *  pre-list document normalizes to. Pass `triggers` when the suite is ABOUT
 *  having more than one. */
export function automationDoc(input: {
  id: AppId;
  name?: string;
  trigger?: Omit<Trigger, "id">;
  triggers?: Trigger[];
}): AppDocument {
  const triggers = input.triggers
    ?? (input.trigger === undefined ? [] : [{ id: "main", ...input.trigger }]);
  return {
    format: "vendo/app@1",
    id: input.id,
    name: input.name ?? input.id,
    triggers,
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

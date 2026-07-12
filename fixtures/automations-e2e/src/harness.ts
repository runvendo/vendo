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
import { createGuard, type PolicyConfig, type VendoGuard } from "@vendoai/guard";
import { createActions } from "@vendoai/actions";
import { createApps, type AppsRuntime, type SandboxAdapter } from "@vendoai/apps";
import { createAutomations, type AutomationsEngine } from "@vendoai/automations";

export const fixtureBaseUrl = (): string => inject("fixtureBaseUrl");

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
}

export async function createStack(options: StackOptions = {}): Promise<Stack> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-automations-e2e-"));
  const store = createStore({ dataDir });
  await store.ensureSchema();
  const guard = createGuard({ store, ...(options.policy === undefined ? {} : { policy: options.policy }) });
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

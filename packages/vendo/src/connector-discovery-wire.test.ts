/**
 * Connector discovery (design 2026-08-03), on the ONE registry, through the real
 * composition.
 *
 * The unit tests (packages/agent/src/connector-discovery.test.ts) prove the
 * registry against fake ports. These prove the WIRING: that each tool exists
 * exactly as far as an adapter backs it, that a dispatch reaches the broker's own
 * slug through the guard (so the per-slug grade decides run/ask and the audit row
 * names the toolkit), and that both surfaces answer for the CALLER rather than
 * the deployment.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connector, ConnectorAccount, ServiceToolMatch } from "@vendoai/actions";
import type { Principal, RiskLabel, RunContext } from "@vendoai/core";
import { auditStore, createStore, type VendoStore } from "@vendoai/store";
import type { PolicyRule } from "@vendoai/guard";
import type { LanguageModel } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_disco" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "s_disco" };

/** The broker's catalog as ITS search returns it: slug, schema and connect status
 *  inline, so one round trip is all the model needs. Gmail is connected for this
 *  subject; slack is not. */
const CATALOG: Record<string, ServiceToolMatch & { risk: RiskLabel }> = {
  GMAIL_SEND_EMAIL: {
    slug: "GMAIL_SEND_EMAIL",
    toolkit: "gmail",
    description: "Send an email from the connected Gmail account",
    inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
    connected: true,
    risk: "write",
  },
  GMAIL_DELETE_THREAD: {
    slug: "GMAIL_DELETE_THREAD",
    toolkit: "gmail",
    description: "Permanently delete an email thread",
    inputSchema: { type: "object" },
    connected: true,
    risk: "destructive",
  },
  SLACK_LIST_CHANNELS: {
    slug: "SLACK_LIST_CHANNELS",
    toolkit: "slack",
    description: "List the channels in a Slack workspace",
    // No schema from the broker: the row has to SAY so.
    connected: false,
    statusMessage: "Connect Slack to use this tool.",
    risk: "read",
  },
};

interface BrokerSpy { dispatched: Array<{ slug: string; args: unknown; subject: string }> }

/** A broker with the whole find → grade → use loop, the shape the real adapter
 *  has. `searchTools` answers for the CALLER; `toolRisk` is the ownership answer
 *  and the grade at once. */
function broker(spy: BrokerSpy = { dispatched: [] }): Connector & { spy: BrokerSpy } {
  const accounts: ConnectorAccount[] = [
    { id: "ca_gmail", connector: "composio", toolkit: "gmail", status: "active" },
  ];
  return {
    name: "composio",
    spy,
    descriptors: async () => [],
    execute: async () => ({ status: "error", error: { code: "not-found", message: "no listed tools" } }),
    searchTools: async (need, searchCtx) => {
      const connected = searchCtx.principal.subject === principal.subject;
      return Object.values(CATALOG)
        .filter((entry) => need.includes(entry.toolkit))
        .map(({ risk: _risk, ...match }) => ({ ...match, connected: match.connected && connected }));
    },
    toolRisk: async (slug) => CATALOG[slug]?.risk,
    executeSlug: async (slug, args, execCtx) => {
      spy.dispatched.push({ slug, args, subject: execCtx.principal.subject });
      return {
        status: "ok",
        output: { ran: slug },
        connectorAccount: { connector: "composio", toolkit: CATALOG[slug]!.toolkit, entityId: execCtx.principal.subject },
      } as never;
    },
    connections: {
      // Subject-scoped, like every real broker: one principal never observes
      // another's accounts.
      list: async (subject) => (subject === principal.subject ? accounts : []),
      initiate: async () => ({ id: "ca_new", redirectUrl: "https://connect.test/x" }),
      status: async () => accounts[0] ?? null,
      disconnect: async () => undefined,
      listConnectable: async () => [
        { toolkit: "gmail", label: "Gmail", description: "Send and read email with Gmail" },
        { toolkit: "slack", label: "Slack", description: "Post messages to Slack channels" },
      ],
    },
  };
}

/** The zero-key Cloud default's shape: real connections, no catalog behind them. */
function connectionsOnly(): Connector {
  const { name, descriptors, execute, connections } = broker();
  return { name, descriptors, execute, connections: connections! };
}

/** ONE real store for the whole file: a PGlite boot costs ~15s and the
 *  compositions below are cheap, so paying that per test would make this file the
 *  slowest in the suite for no extra coverage. */
let shared: VendoStore | undefined;
beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-disco-"));
  const store = createStore({ dataDir });
  await store.ensureSchema();
  shared = store;
  cleanups.push(async () => {
    shared = undefined;
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
});

async function compose(
  connectors: Connector[],
  rules?: PolicyRule[],
  overrides: { toolOutputCap?: number } = {},
): Promise<Vendo> {
  return createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store: shared!,
    connectors,
    ...(rules === undefined ? {} : { guard: { policy: { rules } } }),
    ...overrides,
  });
}

const names = async (vendo: Vendo, runCtx: RunContext = ctx): Promise<string[]> =>
  (await vendo.guardedTools.descriptors(runCtx)).map((descriptor) => descriptor.name);

describe("each tool exists exactly as far as an adapter backs it", () => {
  it("projects all three on a connector that can search, grade and dispatch", async () => {
    const listed = await names(await compose([broker()]));
    expect(listed).toContain("find_service_tools");
    expect(listed).toContain("use_service_tool");
    expect(listed).toContain("list_connections");
  });

  it("projects list_connections ALONE on a connector with no catalog behind it", async () => {
    // The zero-key Cloud default. "What can I connect?" is still a real
    // standalone question, but a search tool with no search backend would answer
    // nothing — and there is deliberately no keyword-scoring fallback.
    const listed = await names(await compose([connectionsOnly()]));
    expect(listed).toContain("list_connections");
    expect(listed).not.toContain("find_service_tools");
    expect(listed).not.toContain("use_service_tool");
  });

  it("projects list_connections ALONE when the broker cannot GRADE its own tools", async () => {
    // Grading is how a slug is claimed, so a broker that cannot grade can never
    // dispatch: projecting the pair would put a tool on the listing that always
    // answers "no such tool".
    const { toolRisk: _ungraded, ...ungradable } = broker();
    const listed = await names(await compose([ungradable]));
    expect(listed).toContain("list_connections");
    expect(listed).not.toContain("find_service_tools");
    expect(listed).not.toContain("use_service_tool");
  });

  it("projects NOTHING when no connector is configured", async () => {
    // An explicit empty array is a choice ("no connectors"), and a host that made
    // it must not be handed discovery machinery with nothing behind it.
    const listed = await names(await compose([]));
    expect(listed).not.toContain("find_service_tools");
    expect(listed).not.toContain("use_service_tool");
    expect(listed).not.toContain("list_connections");
  });

  it("withholds the dispatcher from an unattended run, and keeps the two lookups", async () => {
    // §12 + #747: an `ungraded` tool needs a PERSON, and an away run has none.
    // The consequence is deliberate — an automation cannot reach the third-party
    // catalog through one ungraded dispatcher — and it falls out of the law, not
    // out of a special case here.
    const away: RunContext = { ...ctx, venue: "automation", presence: "away" };
    const listed = await names(await compose([broker()]), away);
    expect(listed).not.toContain("use_service_tool");
    expect(listed).toContain("find_service_tools");
    expect(listed).toContain("list_connections");
  });
});

describe("find_service_tools", () => {
  it("returns the broker's matches with their schemas INLINE — the listing never changes", async () => {
    const vendo = await compose([broker()]);
    // Nothing of the broker's catalog is on the tool listing, and nothing this
    // call does puts it there. That is the point: no client re-lists.
    expect(await names(vendo)).not.toContain("GMAIL_SEND_EMAIL");

    const outcome = await vendo.guardedTools.execute(
      { id: "d1", tool: "find_service_tools", args: { need: "send a gmail message" } },
      ctx,
    );
    expect(outcome.status).toBe("ok");
    const { tools } = (outcome as { output: { tools: Array<Record<string, unknown>> } }).output;
    expect(tools.find((row) => row["slug"] === "GMAIL_SEND_EMAIL")).toMatchObject({
      toolkit: "gmail",
      connected: true,
      inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
    });
    expect(await names(vendo)).not.toContain("GMAIL_SEND_EMAIL");
  });

  it("marks a match the broker gave no schema for, and carries the broker's own next step", async () => {
    const vendo = await compose([broker()]);
    const outcome = await vendo.guardedTools.execute(
      { id: "d2", tool: "find_service_tools", args: { need: "list slack channels" } },
      ctx,
    );
    const [row] = (outcome as { output: { tools: Array<Record<string, unknown>> } }).output.tools;
    expect(row).toMatchObject({ slug: "SLACK_LIST_CHANNELS", connected: false, statusMessage: "Connect Slack to use this tool." });
    expect(row).not.toHaveProperty("inputSchema");
    expect(row!["schemaUnavailable"]).toMatch(/do not guess arguments/i);
  });

  it("never returns a row from a connector use_service_tool cannot reach", async () => {
    // Two brokers, one of which can only SEARCH. Fanning search out wider than
    // dispatch can follow hands the model rows that always come back "no such
    // tool" — the same class of lie as projecting a tool with no adapter.
    const searchOnly: Connector = {
      name: "search-only",
      descriptors: async () => [],
      execute: async () => ({ status: "ok", output: {} }),
      searchTools: async () => [{
        slug: "GHOST_SEND_EMAIL",
        toolkit: "gmail",
        description: "A tool nothing here can run",
        connected: true,
      }],
    };
    const vendo = await compose([searchOnly, broker()]);
    const outcome = await vendo.guardedTools.execute(
      { id: "d4", tool: "find_service_tools", args: { need: "send a gmail message" } },
      ctx,
    );
    const { tools } = (outcome as { output: { tools: Array<{ slug: string }> } }).output;
    expect(tools.map((row) => row.slug)).not.toContain("GHOST_SEND_EMAIL");
    expect(tools.map((row) => row.slug)).toContain("GMAIL_SEND_EMAIL");
  });

  it("answers per PERSON: a stranger sees the same tools, none of them connected", async () => {
    const vendo = await compose([broker()]);
    const stranger: RunContext = { ...ctx, principal: { kind: "user", subject: "user_stranger" } };
    const outcome = await vendo.guardedTools.execute(
      { id: "d3", tool: "find_service_tools", args: { need: "send a gmail message" } },
      stranger,
    );
    const { tools } = (outcome as { output: { tools: Array<{ connected: boolean }> } }).output;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((row) => row.connected === false)).toBe(true);
  });
});

describe("a search is bounded by the host's OWN tool-output cap", () => {
  /** A broker whose schemas are the size real ones are (Composio's run 5–7KB a
   *  match), so the result would run past a tool-output cap and be cut
   *  mid-schema if nothing bounded it first. */
  function bulkyBroker(): Connector {
    const paragraph =
      "Composio's parameter descriptions run a full paragraph: they restate the constraint, name the "
      + "sibling fields the value interacts with, and give the format the provider expects.";
    const match = (index: number): ServiceToolMatch => ({
      slug: `BULK_TOOL_${index}`,
      toolkit: "gmail",
      description: `Bulk tool ${index}`,
      connected: true,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 10 }, (_, field) => [`field_${field}`, { type: "string", description: paragraph }]),
        ),
      },
    });
    return {
      ...broker(),
      searchTools: async () => Array.from({ length: 10 }, (_, index) => match(index)),
      toolRisk: async (slug) => (slug.startsWith("BULK_TOOL_") ? "read" : undefined),
    };
  }

  it("keeps the answer under the cap the host set, and names what it left out", async () => {
    // Not the shipped 32,000: a host may set its own, and a bound that reads a
    // constant of its own would sail straight past it.
    const vendo = await compose([bulkyBroker()], undefined, { toolOutputCap: 8_000 });
    const outcome = await vendo.guardedTools.execute(
      { id: "d9", tool: "find_service_tools", args: { need: "send a gmail message" } },
      ctx,
    );

    expect(outcome.status).toBe("ok");
    const output = (outcome as { output: Record<string, unknown> }).output;
    const tools = output["tools"] as Array<Record<string, unknown>>;
    // What the bridge would measure — and it never reaches the cap, so it is
    // never cut mid-schema.
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(8_000);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThan(10);
    expect(tools.every((row) => row["inputSchema"] !== undefined)).toBe(true);
    expect(output["moreMatches"]).toBe(10 - tools.length);
  });
});

describe("use_service_tool goes through the guard, like every other tool", () => {
  it("dispatches to the broker's slug and names the toolkit on the audit row", async () => {
    const spy: BrokerSpy = { dispatched: [] };
    const vendo = await compose([broker(spy)]);

    const outcome = await vendo.guardedTools.execute(
      { id: "aud_use_ok", tool: "use_service_tool", args: { slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@b.c" } } },
      ctx,
    );

    expect(outcome.status).toBe("ok");
    expect(spy.dispatched).toEqual([{ slug: "GMAIL_SEND_EMAIL", args: { to: "a@b.c" }, subject: principal.subject }]);
    // The audit row is the guard's, for free — no second audit path. The toolkit
    // reaches it because the outcome's `connectorAccount` passthrough survives
    // the registry untouched, exactly as it does for a listed connector tool.
    const { events } = await auditStore(shared!).query({ kind: "tool-call" });
    const detail = events
      .filter((event) => event.tool === "use_service_tool")
      .map((event) => (event.detail ?? {}) as { connectorAccount?: { toolkit?: string } });
    expect(detail.some((entry) => entry.connectorAccount?.toolkit === "gmail")).toBe(true);
  });

  it("lets the broker's per-slug grade decide run vs ask", async () => {
    // The descriptor is `ungraded` for BOTH of these calls and the policy rule
    // matches on RISK, not on tool name — so the rule can only fire if the grade
    // the broker put on this particular slug reached the guard through the
    // resolveRisk chain. That chain is the whole seam this design rests on.
    const spy: BrokerSpy = { dispatched: [] };
    const vendo = await compose([broker(spy)], [{ match: { risk: "destructive" }, action: "ask" }]);

    const read = await vendo.guardedTools.execute(
      { id: "d5", tool: "use_service_tool", args: { slug: "SLACK_LIST_CHANNELS" } },
      ctx,
    );
    expect(read.status).toBe("ok");

    const destructive = await vendo.guardedTools.execute(
      { id: "d6", tool: "use_service_tool", args: { slug: "GMAIL_DELETE_THREAD" } },
      ctx,
    );
    expect(destructive.status).toBe("pending-approval");
    // Parked, not run: the approval card exists precisely so this has not happened.
    expect(spy.dispatched.map((entry) => entry.slug)).toEqual(["SLACK_LIST_CHANNELS"]);
  });

  it("refuses an unknown slug cleanly, without an approval card for a call that cannot run", async () => {
    const spy: BrokerSpy = { dispatched: [] };
    const vendo = await compose([broker(spy)]);

    const outcome = await vendo.guardedTools.execute(
      { id: "d7", tool: "use_service_tool", args: { slug: "GMAIL_SEND_MSG" } },
      ctx,
    );

    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
    expect((outcome as { error: { message: string } }).error.message).toContain("find_service_tools");
    expect(spy.dispatched).toEqual([]);
  });
});

describe("list_connections", () => {
  it("reports every connectable service with THIS subject's connect status", async () => {
    const vendo = await compose([broker()]);
    const outcome = await vendo.guardedTools.execute({ id: "d8", tool: "list_connections", args: {} }, ctx);
    expect(outcome.status).toBe("ok");
    const { connections } = (outcome as { output: { connections: Array<{ toolkit: string; connected: boolean }> } }).output;
    expect([...connections].sort((a, b) => (a.toolkit < b.toolkit ? -1 : 1))).toEqual([
      { toolkit: "gmail", label: "Gmail", description: "Send and read email with Gmail", connected: true },
      { toolkit: "slack", label: "Slack", description: "Post messages to Slack channels", connected: false },
    ]);
  });

  it("answers per PERSON: a stranger with no accounts sees everything unconnected", async () => {
    const vendo = await compose([broker()]);
    const stranger: RunContext = { ...ctx, principal: { kind: "user", subject: "user_stranger" } };
    const outcome = await vendo.guardedTools.execute({ id: "d9", tool: "list_connections", args: {} }, stranger);
    const { connections } = (outcome as { output: { connections: Array<{ connected: boolean }> } }).output;
    expect(connections.every((row) => row.connected === false)).toBe(true);
  });
});

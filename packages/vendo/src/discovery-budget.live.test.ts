import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composioConnector } from "@vendoai/actions";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "./server.js";

/**
 * Discovery-discipline live proof (criteria 13 + 14), COMPOSIO_API_KEY-gated.
 *
 * CRITERIA AS SIGNED — this file asserts them verbatim, after an earlier
 * version of it was caught reinterpreting them:
 *  13. ≤ 6 connector HTTP round-trips TOTAL for the turn (was ~40). Total
 *      means total: `/tools/execute` calls are counted like every other one.
 *  14. Exactly ONE connect card, and zero approval prompts before connecting.
 *
 * A turn that ERRORS proves nothing, so every assertion below is gated on the
 * turn having actually succeeded: a stream error part, a connector transport
 * failure (DNS, refused, 5xx), or a turn that never reached the connector all
 * fail the test loudly instead of passing on a low count.
 *
 * The host half is real: a local HTTP server backs one host tool that returns
 * the spending data, mirroring Maple, where the agent gets spending from host
 * tools and uses the connector only to send. (Without a host tool the agent
 * reads the user's actual Gmail to synthesise the data — real work, but not
 * the Maple shape, and it is what made the earlier version look over budget.)
 *
 * Identity: `flowlet-demo`, the workspace entity holding the ACTIVE Gmail
 * connection — the same live entity composio.live.test.ts uses. Maple's own
 * subject cannot be connected from an agent session (it needs the human's
 * Google password at Google's consent screen); that gap is parked in
 * PARKED.md, not papered over here.
 *
 * Nothing is sent: the policy asks on write and the test never approves, so
 * the guarded gmail write parks as an approval instead of delivering mail.
 */

const apiKey = process.env.COMPOSIO_API_KEY;
const hasModel = Boolean(process.env.ANTHROPIC_API_KEY);

const CONNECTED_ENTITY = "flowlet-demo";
const ASK = "email me a summary of my spending this month";
/** Criterion 13, verbatim: ≤ 6 connector HTTP round-trips total per turn. */
const ROUND_TRIP_BUDGET = 6;

const SPENDING = {
  month: "July 2026",
  categories: [
    { category: "Housing", amount: 285000 },
    { category: "Shopping", amount: 61749 },
    { category: "Dining", amount: 35709 },
  ],
  totalCents: 382458,
};

interface Counter {
  urls: string[];
  failures: string[];
  reset(): void;
}

/** Counts EVERY Composio round-trip, and records transport failures so a run
 *  that could not reach the broker can never masquerade as a cheap turn. */
function countComposioCalls(): Counter {
  const real = globalThis.fetch;
  const urls: string[] = [];
  const failures: string[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const isComposio = url.includes("backend.composio.dev");
    if (isComposio) urls.push(url);
    try {
      const response = await real(input as never, init);
      if (isComposio && response.status >= 500) failures.push(`${response.status} ${url}`);
      return response;
    } catch (error) {
      if (isComposio) failures.push(`${error instanceof Error ? error.message : String(error)} ${url}`);
      throw error;
    }
  }) as typeof fetch;
  cleanups.push(() => {
    globalThis.fetch = real;
  });
  return {
    urls,
    failures,
    reset: () => {
      urls.splice(0, urls.length);
      failures.splice(0, failures.length);
    },
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The host half: one real HTTP route behind one extracted host tool. */
async function startHostApi(): Promise<string> {
  const server: Server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/api/spending")) {
      response.end(JSON.stringify(SPENDING));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.close();
    server.closeAllConnections();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A `.vendo/` project dir declaring that host tool, and a chdir into it —
 *  createVendo reads the actions dir from the process cwd. */
async function useProjectDir(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vendo-discovery-project-"));
  await mkdir(join(root, ".vendo"), { recursive: true });
  await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
    format: "vendo/tools@3",
    tools: [{
      name: "host_spending_summary",
      description: "This month's spending by category for the signed-in user.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/spending", argsIn: "query" },
    }],
  }));
  const previous = process.cwd();
  process.chdir(root);
  cleanups.push(async () => {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  });
}

async function composeVendo(entityId: string, baseUrl: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-discovery-live-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  // Host route bindings resolve against VENDO_BASE_URL (the operator-set,
  // credential-trusted origin); there is no top-level baseUrl config.
  const previousBaseUrl = process.env.VENDO_BASE_URL;
  process.env.VENDO_BASE_URL = baseUrl;
  cleanups.push(() => {
    if (previousBaseUrl === undefined) delete process.env.VENDO_BASE_URL;
    else process.env.VENDO_BASE_URL = previousBaseUrl;
  });
  const vendo = createVendo({
    store,
    // The demo posture: BYO Composio scoped to the demo's toolkits, guard
    // asking on every write (Maple's .vendo/policy.json intent).
    connectors: [composioConnector({ apiKey: apiKey!, apps: ["gmail", "slack"], entityId: () => entityId })],
    policy: { rules: [{ match: { risk: "write" }, action: "ask" }, { match: { risk: "destructive" }, action: "ask" }] },
    principal: async () => ({ kind: "user", subject: entityId }),
  });
  // Settle composition (boot-time schema load) before the counter is read.
  await vendo.handler(new Request("http://live.test/api/vendo/status"));
  return vendo;
}

interface TurnResult {
  stream: string;
  connectCards: number;
  approvalParts: number;
  paths: string[];
  failures: string[];
}

/** Runs the turn and FAILS on anything that would make the counts meaningless:
 *  a non-200, a stream error part, or a connector transport failure. */
async function runTurn(
  vendo: Awaited<ReturnType<typeof composeVendo>>,
  counter: Counter,
  id: string,
): Promise<TurnResult> {
  const response = await vendo.handler(new Request("http://live.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { id, role: "user", parts: [{ type: "text", text: ASK }] } }),
  }));
  expect(response.status).toBe(200);
  const stream = await response.text();
  const paths = counter.urls.map((url) => new URL(url).pathname);

  // A broken turn must never read as a cheap one.
  expect(counter.failures, `connector transport failed: ${counter.failures.join("; ")}`).toEqual([]);
  expect(stream, "the turn streamed an error part").not.toContain('"type":"error"');
  expect(stream.length, "the turn produced no stream").toBeGreaterThan(0);

  return {
    stream,
    connectCards: stream.split("data-vendo-connect").length - 1,
    approvalParts: stream.split("data-vendo-approval").length - 1,
    paths,
    failures: counter.failures,
  };
}

describe.skipIf(!apiKey || !hasModel)("discovery discipline, live (criteria 13 + 14)", () => {
  it("criterion 13 — a CONNECTED-service turn costs ≤ 6 connector round-trips TOTAL", async () => {
    await useProjectDir();
    const baseUrl = await startHostApi();
    const counter = countComposioCalls();
    const vendo = await composeVendo(CONNECTED_ENTITY, baseUrl);
    const boot = counter.urls.length;
    counter.reset();

    const turn = await runTurn(vendo, counter, "user_live_connected");

    console.info(`[live] criterion 13 — boot: ${boot} · turn TOTAL: ${turn.paths.length}`, turn.paths);
    // The turn must actually have reached the connector; a turn that never
    // touched it would score 0 and prove nothing.
    expect(turn.paths.length, "the turn never reached the connector").toBeGreaterThan(0);
    expect(turn.paths.length).toBeLessThanOrEqual(ROUND_TRIP_BUDGET);
    // Connected means connected: no connect card on this path.
    expect(turn.connectCards).toBe(0);
    // Boot pays one schema load per scoped toolkit — never a catalog walk.
    expect(boot).toBeLessThanOrEqual(2);
  }, 240_000);

  it("criterion 14 — an UNCONNECTED service shows EXACTLY one connect card and zero approvals", async () => {
    await useProjectDir();
    const baseUrl = await startHostApi();
    const counter = countComposioCalls();
    // A subject no broker account can match: the connect-required path.
    const vendo = await composeVendo(`vendo-live-unconnected-${process.pid}`, baseUrl);
    counter.reset();

    const turn = await runTurn(vendo, counter, "user_live_unconnected");

    console.info(`[live] criterion 14 — turn TOTAL: ${turn.paths.length}`, turn.paths);
    // Exactly one, as signed — not "at most one".
    expect(turn.connectCards).toBe(1);
    // Zero approvals BEFORE connecting: the gate rules before the guard.
    expect(turn.approvalParts).toBe(0);
    const approvals = await (await vendo.handler(new Request("http://live.test/api/vendo/approvals"))).json() as unknown[];
    expect(approvals).toEqual([]);
    // The gate's other claim: the unconnected toolkit never reaches the broker.
    expect(turn.paths.filter((path) => path.startsWith("/api/v3/tools/execute/"))).toEqual([]);
    expect(turn.paths.length).toBeLessThanOrEqual(ROUND_TRIP_BUDGET);
  }, 240_000);
});

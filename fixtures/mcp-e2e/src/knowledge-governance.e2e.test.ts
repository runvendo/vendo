/**
 * Knowledge k8 T5 (ENG-370, KB-COV-7) — the MCP leg of the visibility
 * governance matrix: a REAL MCP SDK client calls vendo_knowledge_search
 * through the umbrella-mounted door against a corpus whose internal doc
 * matches the query, and the internal doc never crosses the door. The other
 * three venue legs (chat, app, automation) live in
 * packages/vendo/src/knowledge-governance.test.ts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import type { Principal } from "@vendoai/core";
import type { HostOAuthAdapter } from "@vendoai/mcp";
import { createStore, type VendoStore } from "@vendoai/store";
import { createVendo, type CreateVendoConfig, type Vendo } from "@vendoai/vendo/server";
import { afterEach, describe, expect, it } from "vitest";
import { SUBJECT, type Stack } from "./harness.js";
import { connectWithSdk, textOf } from "./support.js";

const MCP_PATH = "/api/vendo/mcp";
const INTERNAL_ID = "internal-fraud-runbook";
const INTERNAL_MARKER = "SAR checklist";
const PUBLIC_ID = "docs-escalations";

interface Umbrella {
  vendo: Vendo;
  endpoint: string;
  close(): Promise<void>;
}

const open: Umbrella[] = [];

afterEach(async () => {
  for (const umbrella of open.splice(0).reverse()) await umbrella.close();
});

async function createKnowledgeUmbrella(): Promise<Umbrella> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-knowledge-mcp-"));
  const store: VendoStore = createStore({ dataDir });
  const oauth: HostOAuthAdapter = {
    async authorize() {
      return { subject: SUBJECT };
    },
    async principal(subject) {
      return { kind: "user", subject, display: `Fixture ${subject}` } satisfies Principal;
    },
  };
  const config: CreateVendoConfig = {
    model: {} as unknown as CreateVendoConfig["model"],
    principal: async () => null,
    store,
    // The shipped read posture: the call RUNS at the door, so the leg proves
    // zero leakage on execution (init's vendo_knowledge_* → ask hardening is
    // its own test in packages/vendo/src/cli/init.test.ts).
    policy: {
      rules: [
        { match: { risk: "destructive" }, action: "ask" },
        { match: { risk: "read" }, action: "run" },
      ],
    },
    oauth,
    knowledge: memoryKnowledgeAdapter({
      docs: [
        {
          id: PUBLIC_ID,
          kind: "docs",
          visibility: "public",
          title: "Escalating a dispute",
          text: "Customers can request an escalation of a dispute from the transaction detail view; escalation review takes two business days.",
          source: "help.maple.bank/disputes/escalation",
        },
        {
          id: INTERNAL_ID,
          kind: "docs",
          visibility: "internal",
          title: "Fraud escalation runbook (internal)",
          text: "INTERNAL: on a fraud escalation, freeze the card, page the on-call risk analyst, and file the SAR checklist within 24 hours.",
          source: "wiki.maple.internal/risk/fraud-runbook",
        },
      ],
    }),
  };
  let handler: Vendo["handler"] | undefined;
  const httpServer = createServer((req, res) => void bridge(req, res, (request) => handler!(request)));
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("knowledge umbrella did not bind a port");
  const origin = `http://127.0.0.1:${address.port}`;
  const vendo = createVendo({ ...config, mcp: { baseUrl: origin } });
  handler = vendo.handler;
  const umbrella: Umbrella = {
    vendo,
    endpoint: `${origin}${MCP_PATH}`,
    async close() {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  open.push(umbrella);
  return umbrella;
}

describe("visibility governance — MCP leg (k8 T5)", () => {
  it("vendo_knowledge_search over the door answers from public docs only and audits as venue mcp", async () => {
    const umbrella = await createKnowledgeUmbrella();
    const connected = await connectWithSdk(umbrella as unknown as Stack);
    try {
      const result = await connected.client.callTool({
        name: "vendo_knowledge_search",
        arguments: { query: "escalation" },
      });
      expect(result.isError).not.toBe(true);
      const text = textOf(result);
      expect(text).toContain(PUBLIC_ID);
      expect(text).not.toContain(INTERNAL_ID);
      expect(text).not.toContain(INTERNAL_MARKER);

      const raw = umbrella.vendo.store.raw() as { query(q: string, p?: unknown[]): Promise<{ rows: unknown[] }> };
      const rows = (await raw.query(
        "SELECT tool, venue FROM vendo_audit WHERE kind = 'tool-call' AND tool = 'vendo_knowledge_search'",
      )).rows as Array<{ tool: string; venue: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.venue === "mcp")).toBe(true);
    } finally {
      await connected.close();
    }
  });
});

async function bridge(
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
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end(error instanceof Error ? error.message : "knowledge umbrella bridge failed");
  }
}

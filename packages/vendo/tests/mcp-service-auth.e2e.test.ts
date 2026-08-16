/**
 * THE SEAM, both halves real: a host's backend exchanges a service key for a
 * user-bound token at the composed door's own token endpoint, calls a host tool
 * over MCP with it, and the audit row that lands in the REAL store names the
 * key that made the call.
 *
 * Nothing is stubbed on either side. The producer is the door's token desk
 * (`packages/mcp`), the consumer is the guard's audit sink writing through the
 * composed store, and the only wire between them is `vendo.handler`. A harness
 * that mocked either end could never catch `clientId` failing to make the trip
 * from the OAuth grant, through the RunContext, onto the row.
 */
import type { AuditEvent } from "@vendoai/core";
import type { VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOUNT,
  READ_TOOL,
  SUBJECT,
  hostTools,
  openDoor,
  principal,
  runCleanups,
  tempStore,
} from "../src/mcp-door.test-util.js";
import { createVendo, type Vendo } from "../src/server.js";

afterEach(runCleanups);
afterEach(() => vi.unstubAllEnvs());

/** An opaque key — the door never parses one — and the label it earns: `svc:`
 *  plus the first 8 hex of its sha256, pinned literally so a change to that
 *  derivation cannot pass. */
const KEY = "vsk_0123456789abcdef0123456789abcdef0123456789abcdef";
const SERVICE_CLIENT = "svc:5c006a4c";

/** The host, composed with service auth on and nothing else changed. */
async function composedHost(): Promise<{ vendo: Vendo; store: VendoStore }> {
  const store = await tempStore();
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    guard: { policy: "cautious" },
    mcp: { serviceAuth: { keys: [KEY] } },
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
  return { vendo, store };
}

/** The backend's own HTTP call — a form post, exactly as `curl` would send it. */
async function exchange(vendo: Vendo, subject: string): Promise<string> {
  const response = await vendo.handler(new Request(`${MOUNT}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: "vendo-service",
      client_secret: KEY,
      subject_token: subject,
      subject_token_type: "urn:vendo:params:oauth:token-type:user-id",
      resource: MOUNT,
    }),
  }));
  if (response.status !== 200) throw new Error(`exchange failed ${response.status}: ${await response.text()}`);
  const body = await response.json() as { access_token: string; expires_in: number; refresh_token?: string };
  expect(body.access_token).toMatch(/^vmat_/);
  expect(body.expires_in).toBe(600);
  expect(body.refresh_token).toBeUndefined();
  return body.access_token;
}

const auditRows = async (store: VendoStore): Promise<AuditEvent[]> => {
  const { records } = await store.records("vendo_audit").list({ refs: { subject: SUBJECT } });
  return records.map((record) => record.data as unknown as AuditEvent);
};

describe("first-party service auth, end to end through the composed door", () => {
  it("exchanges a key for a user's token, runs a host tool, and names the key on the audit row", async () => {
    const { vendo, store } = await composedHost();

    const token = await exchange(vendo, SUBJECT);
    const door = await openDoor(vendo, token);
    const answered = await door.callTool(READ_TOOL, { query: "balance" });
    expect(answered.isError).toBeFalsy();

    const rows = await auditRows(store);
    const call = rows.find((row) => row.kind === "tool-call" && row.tool === READ_TOOL);
    expect(call).toBeDefined();
    // The whole point of A1: the ledger says WHICH client made the call, and a
    // service key is a client like any other.
    expect(call?.clientId).toBe(SERVICE_CLIENT);
    expect(call?.presence).toBe("present");
    expect(call?.venue).toBe("mcp");
    expect(call?.principal.subject).toBe(SUBJECT);
    // And the exchange itself is on the ledger, under the same name.
    expect(rows.find((row) => row.kind === "door-auth")?.detail)
      .toEqual({ clientId: SERVICE_CLIENT, event: "exchange" });
  });

  // THE CUSTOMER CASE: a deployment that declares a broker in its environment
  // and configures `serviceAuth` in code. The env var is a DEFAULT and the code
  // is explicit, so the door keeps its own token endpoint — proven through the
  // same real exchange and the same real MCP session as above, because a door
  // that took the broker default 404s `{mount}/token` and this whole flow dies.
  it("keeps the exchange alive when the deployment also declares VENDO_MCP_BROKER_URL", async () => {
    vi.stubEnv("VENDO_MCP_BROKER_URL", "https://acme.mcp.vendo.run/mcp");
    const { vendo } = await composedHost();

    const token = await exchange(vendo, SUBJECT);
    const door = await openDoor(vendo, token);
    expect((await door.callTool(READ_TOOL, { query: "balance" })).isError).toBeFalsy();
  });

  it("answers a subject_token the store cannot hold with an OAuth error, not a crash", async () => {
    const { vendo, store } = await composedHost();

    // `subject_token` is a bare wire string that goes straight onto a grant's
    // `refs` and an audit row, and Postgres jsonb cannot hold a NUL. The door
    // refuses one before the write, so this lives against the REAL store
    // because that is what makes the guard's ABSENCE fail: an in-memory store
    // holds a NUL happily and would keep this test green with the check gone.
    const response = await vendo.handler(new Request(`${MOUNT}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        client_id: "vendo-service",
        client_secret: KEY,
        subject_token: `${SUBJECT}\u0000admin`,
        subject_token_type: "urn:vendo:params:oauth:token-type:user-id",
        resource: MOUNT,
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect((await store.records("vendo_mcp_grants").list({})).records).toEqual([]);
  });
});

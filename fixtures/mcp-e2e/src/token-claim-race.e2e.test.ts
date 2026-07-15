import { randomUUID } from "node:crypto";
import type { AuditEvent, Guard, Principal, StoreAdapter, ToolRegistry } from "@vendoai/core";
import { createMcpDoor, type HostOAuthAdapter, type McpDoor } from "@vendoai/mcp";
import { createStore, type VendoStore } from "@vendoai/store";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE = "https://product.example/api/vendo/mcp";
const REDIRECT = "https://client.example/callback";
const VERIFIER = "a-very-long-pkce-verifier-that-is-valid-for-the-race-test-1234567890";
const RACE_ITERATIONS = 25;
const POSTGRES_URL = process.env.POSTGRES_URL;

const describePostgres = POSTGRES_URL ? describe : describe.skip;

describePostgres("multi-instance OAuth token claims (Postgres)", () => {
  let admin: Client;
  let schema: string;
  let firstStore: VendoStore;
  let secondStore: VendoStore;
  let firstDoor: McpDoor;
  let secondDoor: McpDoor;
  let claimBarrier: ClaimBarrier;
  const audits: AuditEvent[] = [];

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    admin = new Client({ connectionString: POSTGRES_URL });
    await admin.connect();
    schema = `vendo_eng270_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);

    const isolatedUrl = new URL(POSTGRES_URL);
    const priorOptions = isolatedUrl.searchParams.get("options");
    isolatedUrl.searchParams.set(
      "options",
      [priorOptions, `-c search_path=${schema}`].filter(Boolean).join(" "),
    );

    firstStore = createStore({ url: isolatedUrl.toString() });
    secondStore = createStore({ url: isolatedUrl.toString() });
    await firstStore.ensureSchema();
    await secondStore.ensureSchema();

    claimBarrier = new ClaimBarrier();
    firstDoor = makeDoor(gateTokenClaims(firstStore, claimBarrier), audits);
    secondDoor = makeDoor(gateTokenClaims(secondStore, claimBarrier), audits);
  }, 60_000);

  afterAll(async () => {
    await secondStore?.close();
    await firstStore?.close();
    if (admin && schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  it(`lets exactly one of two server instances redeem an authorization code across ${RACE_ITERATIONS} races`, async () => {
    const clientId = await register(firstDoor);

    for (let iteration = 0; iteration < RACE_ITERATIONS; iteration += 1) {
      const code = await authorize(firstDoor, clientId);
      claimBarrier.arm();
      const responses = await Promise.all([
        exchange(firstDoor, code, clientId),
        exchange(secondDoor, code, clientId),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
      const loser = responses.find((response) => response.status === 400)!;
      expect(await loser.json()).toMatchObject({
        error: "invalid_grant",
        error_description: "Authorization code is invalid or expired",
      });
    }
  });

  it(`lets exactly one refresh rotation win and revokes its successor across ${RACE_ITERATIONS} races`, async () => {
    const clientId = await register(firstDoor);

    for (let iteration = 0; iteration < RACE_ITERATIONS; iteration += 1) {
      const code = await authorize(firstDoor, clientId);
      const issued = await exchange(firstDoor, code, clientId);
      expect(issued.status).toBe(200);
      const first = await issued.json() as TokenResponse;

      claimBarrier.arm();
      const responses = await Promise.all([
        refresh(firstDoor, first.refresh_token, clientId),
        refresh(secondDoor, first.refresh_token, clientId),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
      const winner = responses.find((response) => response.status === 200)!;
      const loser = responses.find((response) => response.status === 400)!;
      const rotated = await winner.json() as TokenResponse;
      expect(await loser.json()).toMatchObject({
        error: "invalid_grant",
        error_description: "Refresh token reuse detected",
      });

      // The losing reuse attempt revokes the whole subject/client chain,
      // including the winner's freshly rotated access and refresh tokens.
      const bearer = await firstDoor.handler(new Request(BASE, {
        method: "POST",
        headers: { authorization: `Bearer ${rotated.access_token}` },
      }));
      expect(bearer.status).toBe(401);
      const successor = await refresh(secondDoor, rotated.refresh_token, clientId);
      expect(successor.status).toBe(400);
      expect(await successor.json()).toMatchObject({ error: "invalid_grant" });
    }

    expect(audits.filter(
      (event) => (event.detail as { event?: unknown } | undefined)?.event === "revoke",
    )).toHaveLength(RACE_ITERATIONS);
  });

  it(`keeps a grant family dead when refresh rotation races revocation across ${RACE_ITERATIONS} races`, async () => {
    const clientId = await register(firstDoor);

    for (let iteration = 0; iteration < RACE_ITERATIONS; iteration += 1) {
      const code = await authorize(firstDoor, clientId);
      const issued = await exchange(firstDoor, code, clientId);
      expect(issued.status).toBe(200);
      const first = await issued.json() as TokenResponse;

      claimBarrier.arm();
      const [rotation, revocation] = await Promise.all([
        refresh(firstDoor, first.refresh_token, clientId),
        revoke(secondDoor, first.refresh_token, clientId),
      ]);

      expect(revocation.status).toBe(200);
      expect(await revocation.text()).toBe("");
      expect([200, 400]).toContain(rotation.status);
      if (rotation.status === 200) {
        const successor = await rotation.json() as TokenResponse;
        expect((await firstDoor.handler(new Request(BASE, {
          method: "POST",
          headers: { authorization: `Bearer ${successor.access_token}` },
        }))).status).toBe(401);
        expect((await refresh(secondDoor, successor.refresh_token, clientId)).status).toBe(400);
      }
      expect((await firstDoor.handler(new Request(BASE, {
        method: "POST",
        headers: { authorization: `Bearer ${first.access_token}` },
      }))).status).toBe(401);
    }
  });
});

function makeDoor(store: StoreAdapter, audits: AuditEvent[]): McpDoor {
  const guard: Guard = {
    async check() { return { action: "run", decidedBy: "default" }; },
    async report(event) { audits.push(event); },
    async directions() { return []; },
    onApprovalDecision() { return () => undefined; },
  };
  const tools: ToolRegistry = {
    async descriptors() { return []; },
    async execute() { throw new Error("token race test never executes tools"); },
  };
  const oauth: HostOAuthAdapter = {
    async authorize() { return { subject: "user_race" }; },
    async principal() { return { kind: "user", subject: "user_race" } satisfies Principal; },
  };
  return createMcpDoor({ tools, guard, oauth, store });
}

/**
 * Hold both instances immediately before their real database claim. This makes
 * every iteration exercise two stale readers contending on the same SQL row,
 * rather than merely hoping request scheduling overlaps.
 */
class ClaimBarrier {
  #remaining = 0;
  #release: (() => void) | undefined;
  #ready: Promise<void> = Promise.resolve();

  arm(): void {
    if (this.#remaining !== 0) throw new Error("claim barrier is already armed");
    this.#remaining = 2;
    this.#ready = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  async arrive(): Promise<void> {
    if (this.#remaining === 0) return;
    this.#remaining -= 1;
    if (this.#remaining === 0) this.#release?.();
    await this.#ready;
  }
}

function gateTokenClaims(store: StoreAdapter, barrier: ClaimBarrier): StoreAdapter {
  return {
    records(collection) {
      const records = store.records(collection);
      const claim = records.claim;
      if (collection !== "vendo_mcp_grants" || !claim) return records;
      return {
        ...records,
        async claim(expected, replacement) {
          await barrier.arrive();
          return claim(expected, replacement);
        },
      };
    },
    blobs(namespace) {
      return store.blobs(namespace);
    },
    async ensureSchema() {
      await store.ensureSchema();
    },
  };
}

async function register(door: McpDoor): Promise<string> {
  const response = await door.handler(new Request(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Race client", redirect_uris: [REDIRECT] }),
  }));
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function authorize(door: McpDoor, clientId: string): Promise<string> {
  const challenge = await pkceChallenge(VERIFIER);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: BASE,
  });
  const response = await door.handler(new Request(`${BASE}/authorize?${params}`));
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!).searchParams.get("code")!;
}

function exchange(door: McpDoor, code: string, clientId: string): Promise<Response> {
  return tokenRequest(door, {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: BASE,
  });
}

function refresh(door: McpDoor, refreshToken: string, clientId: string): Promise<Response> {
  return tokenRequest(door, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    resource: BASE,
  });
}

function revoke(door: McpDoor, token: string, clientId: string): Promise<Response> {
  return door.handler(new Request(`${BASE}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, token_type_hint: "refresh_token", client_id: clientId }),
  }));
}

function tokenRequest(door: McpDoor, values: Record<string, string>): Promise<Response> {
  return door.handler(new Request(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  }));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
}

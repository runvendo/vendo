/**
 * THE SEAM, both halves real: `vendo.tokenFor` mints, the composed door
 * accepts, and a host tool runs as the user the token names.
 *
 * Nothing is stubbed between them on the BYO leg — the producer is
 * `mcp-token.ts`, the consumer is the door's own RFC 8693 endpoint plus a real
 * MCP session, and the only wire is `vendo.handler`. A test that asserted on
 * the form body instead would pass with a token no door would ever take.
 */
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostTools,
  openDoor,
  principal,
  READ_TOOL,
  runCleanups,
  SUBJECT,
  tempStore,
} from "../src/mcp-door.test-util.js";
import { createVendo, type Vendo } from "../src/server.js";

afterEach(runCleanups);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const KEY = "vsk_0123456789abcdef0123456789abcdef0123456789abcdef";
const BASE = "https://host.test";
const COOKIE_USER = "user_1904";

/** The signed-in user, off the raw session cookie — the same seam the door
    authenticates with, so `tokenFor(request)` and the door can never disagree
    about who someone is. */
const compose = async (mcp: unknown): Promise<Vendo> => {
  const store = await tempStore();
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    guard: { policy: "cautious" },
    mcp,
    oauth: {
      async session(request: Request) {
        const subject = /(?:^|;\s*)session=([^;]*)/.exec(request.headers.get("cookie") ?? "")?.[1];
        return subject === undefined ? new Response(null, { status: 302 }) : { subject };
      },
      async principal(subject: string) {
        return { kind: "user", subject };
      },
    },
  } as Parameters<typeof createVendo>[0]);
  vendo.actions.add(hostTools());
  await store.ensureSchema();
  return vendo;
};

const byoHost = (): Promise<Vendo> => compose({ serviceAuth: { keys: [KEY] }, baseUrl: BASE });

describe("vendo.tokenFor, against a BYO door", () => {
  it("mints a token an outside agent connects and runs a host tool with", async () => {
    const vendo = await byoHost();

    const token = await vendo.tokenFor(SUBJECT);
    expect(token).toMatch(/^vmat_/);

    const door = await openDoor(vendo, token);
    const answered = await door.callTool(READ_TOOL, { query: "balance" });
    expect(answered.isError).toBeFalsy();
  });

  it("reads WHO off the request's session cookie", async () => {
    const vendo = await compose({ serviceAuth: { keys: [KEY] } });

    const token = await vendo.tokenFor(new Request(`${BASE}/dashboard`, {
      headers: { cookie: `session=${COOKIE_USER}` },
    }));

    // The door is the only witness that matters: it resolves the grant's
    // subject back to a principal, and the audit row it writes names them.
    const door = await openDoor(vendo, token);
    await door.callTool(READ_TOOL, { query: "balance" });
    const { records } = await vendo.store.records("vendo_audit").list({ refs: { subject: COOKIE_USER } });
    expect(records.length).toBeGreaterThan(0);
  });

  it("refuses a request with no signed-in user rather than minting for nobody", async () => {
    const vendo = await byoHost();
    await expect(vendo.tokenFor(new Request(`${BASE}/dashboard`))).rejects.toThrow(/no signed-in user/);
  });

  it("refuses a blank or \"undefined\" id, naming the fix", async () => {
    const vendo = await byoHost();
    await expect(vendo.tokenFor("")).rejects.toThrow(/vendo\.tokenFor\(user\.id\)/);
    await expect(vendo.tokenFor("undefined")).rejects.toThrow(/vendo\.tokenFor\(user\.id\)/);
  });

  it("refuses a null id with the same guidance, not a raw TypeError", async () => {
    const vendo = await byoHost();
    // `user.id` off a database row is `null`, not `undefined` — the commonest
    // spelling of the very mistake the blank-id refusal exists to name.
    await expect(vendo.tokenFor(null as unknown as string)).rejects.toThrow(/vendo\.tokenFor\(user\.id\)/);
  });

  it("refuses a BigInt id with the same guidance, not a serializer crash", async () => {
    const vendo = await byoHost();
    // Snowflake ids (Discord, X) and postgres int8 arrive as BigInt, and the
    // guard now accepts `unknown` — so its own error path has to survive one.
    await expect(vendo.tokenFor(123n as unknown as string)).rejects.toThrow(/vendo\.tokenFor\(user\.id\)/);
  });

  it("mints and spends a token on a deployment mounted under a path prefix", async () => {
    // A prefixed deployment (`https://host.test/maple`) strips its own prefix
    // before `vendo.handler` sees anything, so the umbrella dispatches the door
    // at its ORIGIN-ROOT mount and the door re-adds the prefix itself when it
    // derives the resource URI. Minting at the public spelling 404s before the
    // door is ever reached — and a token bound to the wrong resource would be
    // refused by the session below even if it did mint.
    const vendo = await compose({ serviceAuth: { keys: [KEY] }, baseUrl: `${BASE}/maple` });

    const token = await vendo.tokenFor(SUBJECT);
    expect(token).toMatch(/^vmat_/);

    const door = await openDoor(vendo, token);
    const answered = await door.callTool(READ_TOOL, { query: "balance" });
    expect(answered.isError).toBeFalsy();
  });

  it("refuses to mint against a door that has no service key, naming both fixes", async () => {
    const vendo = await compose({ baseUrl: BASE });
    await expect(vendo.tokenFor(SUBJECT)).rejects.toThrow(/VENDO_API_KEY.*serviceAuth/s);
  });
});

describe("vendo.tokenFor, against a Cloud-provisioned broker", () => {
  it("exchanges the provisioned service key at the tenant's own token endpoint", async () => {
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    vi.stubEnv("VENDO_BASE_URL", BASE);
    const exchanges: URLSearchParams[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/mcp")) {
        return Response.json({
          issuer: "https://acme.mcp.vendo.run",
          audience: "https://acme.mcp.vendo.run/mcp",
          federation_secret: "fed_0123456789abcdef",
          service_key: "vsk_cloud_0123456789abcdef",
        });
      }
      if (url === "https://acme.mcp.vendo.run/token") {
        exchanges.push(new URLSearchParams(String(init?.body)));
        return Response.json({ access_token: "vmat_from_the_broker", expires_in: 600 });
      }
      return new Response("{}", { status: 200 });
    });

    const vendo = await compose(true);
    expect(await vendo.tokenFor(COOKIE_USER)).toBe("vmat_from_the_broker");

    // RFC 8693, the posture the broker checks: this door's service identity,
    // the provisioned key, and the host's own user id as the subject.
    expect(Object.fromEntries(exchanges[0]!)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: "vendo-service",
      client_secret: "vsk_cloud_0123456789abcdef",
      subject_token: COOKIE_USER,
      subject_token_type: "urn:vendo:params:oauth:token-type:user-id",
      resource: "https://acme.mcp.vendo.run/mcp",
    });
  });
});

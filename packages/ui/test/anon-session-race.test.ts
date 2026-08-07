// @vitest-environment jsdom
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVendoClient } from "../src/index.js";

/**
 * ONE VISITOR, ONE ANONYMOUS IDENTITY — the race.
 *
 * An anonymous visitor's identity IS the opaque session pointer the door mints
 * on a cookie-less wire request, and the door mints one PER REQUEST (see
 * `wire/context.ts`: the `AnonSession` cache is per-invocation, so it can only
 * dedupe WITHIN one request). A cold page load mounts several hooks at once —
 * measured on the live demos: `/status`, `/approvals`, `/automations`,
 * `/activity`, `/connections/catalog`, `/connections` — and every one of them
 * leaves cookie-less. Each therefore minted its own subject and the browser's
 * jar kept whichever Set-Cookie landed last: one visitor became several
 * identities, the rest orphaned.
 *
 * The consequence is the product's trust mechanism failing silently: an agent
 * run creates a consent approval as identity A, the user's Approve arrives as
 * identity B, and `guard.ts` correctly refuses another subject's approval —
 * surfacing as `Approval apr_… was not found` and a run stuck on "waiting for
 * your approval" forever.
 *
 * This MUST be tested as a race. A sequential probe cannot see the bug: the
 * first request's Set-Cookie is already in the jar before the second leaves, so
 * requests issued one at a time always agree on one identity. An earlier probe
 * "eliminated" this very hypothesis for exactly that reason and was wrong.
 */

/** The door's pointer shape (`ANON_ID_PATTERN` in wire/context.ts). */
const ANON_ID_PATTERN = /^[0-9a-f]{32}$/;
const ANON_COOKIE = "vendo_anon_session";

interface FakeDoor {
  url: string;
  /** One entry per request the door served, in completion order. */
  identities: () => string[];
  /** How many times the door had to MINT a new pointer (the bug's measure). */
  mints: () => number;
  close: () => Promise<void>;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function randomPointer(): string {
  const raw = new Uint8Array(16);
  globalThis.crypto.getRandomValues(raw);
  return Array.from(raw, byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A stand-in for the door that reproduces its anonymous-session contract
 * exactly: read the opaque pointer from the Cookie header, and when it is
 * absent or malformed mint a fresh 128-bit one and Set-Cookie it. Deliberately
 * slow (10ms) so every request of a concurrent burst is genuinely in flight
 * before any response returns — that is the window the bug lives in.
 */
async function fakeDoor(): Promise<FakeDoor> {
  const identities: string[] = [];
  let mints = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let id = readCookie(req.headers.cookie, ANON_COOKIE);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (id === null || !ANON_ID_PATTERN.test(id)) {
      id = randomPointer();
      mints += 1;
      headers["set-cookie"] = `${ANON_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`;
    }
    identities.push(id);
    setTimeout(() => {
      res.writeHead(200, headers);
      // Every burst route answers with an empty collection; `/status` is the one
      // object-shaped response, and no assertion here reads the body.
      res.end(req.url?.includes("/status") === true ? "{}" : "[]");
    }, 10);
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    identities: () => [...identities],
    mints: () => mints,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); }),
  };
}

/**
 * Install a browser-grade cookie jar over `globalThis.fetch`: attach the stored
 * cookie to every request, and store what comes back. jsdom/undici's `fetch`
 * keeps no jar of its own, and the jar is the whole point of this test — it is
 * what makes concurrent cookie-less requests indistinguishable to the door, and
 * what keeps only the LAST Set-Cookie.
 */
function installCookieJar(): { restore: () => void; jar: () => Map<string, string> } {
  const real = globalThis.fetch;
  const jar = new Map<string, string>();

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await real(input, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), ...(cookie === "" ? {} : { cookie }) },
    });
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(";")[0]!;
      const eq = pair.indexOf("=");
      if (eq !== -1) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return response;
  };

  return { restore: () => { globalThis.fetch = real; }, jar: () => new Map(jar) };
}

describe("one visitor, one anonymous identity", () => {
  let door: FakeDoor;
  let cookies: ReturnType<typeof installCookieJar>;

  beforeEach(async () => {
    door = await fakeDoor();
    cookies = installCookieJar();
  });

  afterEach(async () => {
    cookies.restore();
    await door.close();
  });

  it("resolves ONE identity across a concurrent cookie-less cold-load burst", async () => {
    const client = createVendoClient({ baseUrl: door.url });

    // The measured cold burst, fired the way mounting hooks fire it: all at
    // once, none of them carrying a cookie yet.
    await Promise.all([
      client.status(),
      client.approvals.pending(),
      client.automations.list(),
      client.activity.list(),
      client.connections.catalog(),
      client.connections.list(),
    ]);

    expect(door.identities()).toHaveLength(6);
    // The bug: 6 requests → 6 mints → 6 subjects, 5 of them orphaned, and the
    // jar keeping whichever landed last.
    expect(new Set(door.identities()).size).toBe(1);
    expect(door.mints()).toBe(1);
    expect(cookies.jar().get(ANON_COOKIE)).toMatch(ANON_ID_PATTERN);
  });

  it("keeps the visitor on the identity the jar already holds (no re-mint)", async () => {
    const client = createVendoClient({ baseUrl: door.url });

    // A first call establishes the pointer, then a warm burst must reuse it —
    // re-minting would move a returning visitor off the session holding their
    // threads, apps and pending approvals.
    await client.status();
    const established = cookies.jar().get(ANON_COOKIE);

    await Promise.all([
      client.approvals.pending(),
      client.automations.list(),
      client.activity.list(),
      client.connections.list(),
    ]);

    expect(door.mints()).toBe(1);
    expect(new Set(door.identities()).size).toBe(1);
    expect(cookies.jar().get(ANON_COOKIE)).toBe(established);
  });
});

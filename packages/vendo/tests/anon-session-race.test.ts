import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

/**
 * THE DOOR'S HALF OF "one visitor, one anonymous identity".
 *
 * The race itself is closed in the SDK's browser client, which is the only
 * layer that can close it honestly (see @vendoai/ui
 * test/anon-session-race.test.ts). These two tests pin the door contract that
 * fix depends on, so it cannot regress silently:
 *
 *  1. The door mints one pointer PER cookie-less request — it genuinely cannot
 *     do otherwise, since two cookie-less requests are indistinguishable from
 *     two visitors. This test states that plainly, because it is the reason the
 *     race is not solvable here and must not be "fixed" here later by
 *     fingerprinting the requester (which would merge two real visitors behind
 *     one NAT) or by deriving the pointer from request attributes (which would
 *     make a live session guessable, where today it is a 2^128 search).
 *
 *  2. A burst that already carries a pointer produces exactly ONE session and
 *     ZERO re-mints. This is what makes the client-side fix work, and equally
 *     what lets a host mint the pointer on its document response: the cookie is
 *     an opaque unsigned pointer whose session row is the authority, so a
 *     pre-established pointer is exactly as valid as a door-minted one.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const ANON_ID_PATTERN = /^[0-9a-f]{32}$/;

async function harness(): Promise<{
  handler: (req: Request) => Promise<Response>;
  sessions: () => Promise<number>;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-anon-race-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  await store.ensureSchema();
  // Anonymous visitor: no host principal resolver result, so every request
  // resolves through the anonymous-session path in wire/context.ts.
  const vendo = createVendo({ principal: async () => null, store });
  const sessions = async (): Promise<number> => {
    const raw = store.raw() as { query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> };
    const result = await raw.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM vendo_sessions WHERE TRUE");
    return Number(result.rows[0]?.count);
  };
  return { handler: req => vendo.handler(req), sessions };
}

/** A cheap GET that resolves context, and so mints/touches the session. */
const listThreads = (cookie?: string): Request =>
  new Request("https://host.test/api/vendo/threads", {
    headers: cookie === undefined ? {} : { cookie },
  });

/** The pointer a response minted, if it minted one. */
const mintedPointer = (res: Response): string | undefined => {
  const setCookie = res.headers.getSetCookie().find(value => value.includes("vendo_anon_session="));
  if (setCookie === undefined) return undefined;
  return setCookie.split(";")[0]!.split("=")[1];
};

describe("the door's anonymous-session minting under a concurrent burst", () => {
  it("mints one pointer per cookie-less request — the race it cannot close alone", async () => {
    const { handler, sessions } = await harness();

    const responses = await Promise.all([
      handler(listThreads()),
      handler(listThreads()),
      handler(listThreads()),
      handler(listThreads()),
    ]);
    await Promise.all(responses.map(res => res.text()));

    const minted = responses.map(mintedPointer);
    expect(minted.every(pointer => pointer !== undefined && ANON_ID_PATTERN.test(pointer))).toBe(true);
    // Four cookie-less requests are four visitors as far as the door can tell,
    // so they are four identities and four sessions. A browser jar would keep
    // only the last, orphaning three — that is the bug, and it is closed in the
    // client, not here.
    expect(new Set(minted).size).toBe(4);
    expect(await sessions()).toBe(4);
  });

  it("accepts an already-established pointer across a parallel burst: one session, zero re-mints", async () => {
    const { handler, sessions } = await harness();

    // A pointer the door never minted — the client's first call, or a host
    // minting on its document response, produces exactly this. The door treats
    // it as canonical because the session row is the authority.
    //
    // The name must match the door's own secure determination: these requests
    // are https, so the door reads ONLY the fixation-proof `__Host-` form. Send
    // the plain name on a secure request and the door reads it as absent and
    // mints its own — silently back to per-request identities. A browser-side
    // fix never has to know this; anything minting the pointer by hand does.
    const established = "0123456789abcdef0123456789abcdef";
    const pointer = `__Host-vendo_anon_session=${established}`;

    const responses = await Promise.all([
      handler(listThreads(pointer)),
      handler(listThreads(pointer)),
      handler(listThreads(pointer)),
      handler(listThreads(pointer)),
      handler(listThreads(pointer)),
      handler(listThreads(pointer)),
    ]);
    await Promise.all(responses.map(res => res.text()));

    expect(responses.map(mintedPointer)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(await sessions()).toBe(1);
  });
});

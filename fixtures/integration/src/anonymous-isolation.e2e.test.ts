/** J7 — ANONYMOUS-SESSION ISOLATION through the composed wire.
 *
 * When `principal(req)` returns null the visitor is anonymous (00 overview,
 * 01-core §2). The umbrella mints a PER-CLIENT ephemeral principal backed by an
 * opaque httpOnly cookie — NOT one shared principal per process (the deferred
 * cross-visitor leak from the composition PR). This journey drives TWO browser-
 * like anonymous clients (their own cookie jars) over real HTTP and proves:
 *
 *   - each cookieless client gets its OWN anonymous subject (distinct cookies),
 *   - a client keeps its subject across requests (cookie round-trip),
 *   - one client's threads / apps / approvals are invisible to the other, and
 *   - anonymous rows land on disk under the client's OWN anonymous subject
 *     (02-store §4, kill-list B3: ordinary rows, erased by the TTL sweep) —
 *     never under another client's subject or a durable one.
 *
 * The harness `wireFetch` always sets x-vendo-test-user (a resolved principal),
 * so this suite talks to the wire DIRECTLY, without that header, managing the
 * anon cookie by hand the way a browser would.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createStack,
  generationTurn,
  readSse,
  resetFixture,
  textTurn,
  toolCallTurn,
  WIRE_BASE,
  type Stack,
} from "./harness.js";

const CREATE_DIALECT = `<App name="Anon's Greeting"><Text text="Hello anon"/></App>`;

/** A single browser-like anonymous client: no x-vendo-test-user, its own cookie
 * jar. Tracks the anon session id (subject = `anonymous_<id>`) and whether the
 * last response tried to mint a new cookie. */
function anonClient(stack: Stack): {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  id(): string | undefined;
  lastMintedCookie(): boolean;
} {
  let cookie: string | undefined;
  let mintedThisFetch = false;
  return {
    async fetch(path, init = {}) {
      const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
      const method = (init.method ?? "GET").toUpperCase();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && headers["content-type"] === undefined) {
        headers["content-type"] = "application/json";
      }
      if (cookie !== undefined) headers.cookie = `vendo_anon_session=${cookie}`;
      const response = await fetch(`${stack.baseUrl}${WIRE_BASE}${path}`, { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      const minted = /vendo_anon_session=([^;]+)/.exec(setCookie ?? "");
      mintedThisFetch = minted !== null;
      if (minted) cookie = minted[1];
      return response;
    },
    id() {
      return cookie?.split(".")[0];
    },
    lastMintedCookie() {
      return mintedThisFetch;
    },
  };
}

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

describe("J7: anonymous sessions are isolated per client through the composed wire", () => {
  it("gives each client its own subject, hides threads/apps/approvals cross-client, and scopes disk rows to the owning subject", async () => {
    await resetFixture();
    stack = await createStack({
      turns: [
        // Client 1, thread thr_anon_app: generate an app (create → generate → text).
        toolCallTurn("vendo_apps_create", { prompt: "Build a greeting card" }, "call_app"),
        // Two-lane create (v2 spec §4): the tier-0 paint lane and the full
        // lane each consume one generation turn.
        generationTurn(CREATE_DIALECT),
        generationTurn(CREATE_DIALECT, "gen_2"),
        textTurn("Created your app.", "t1"),
        // Client 1, thread thr_anon_del: a destructive host tool that the composed
        // policy parks (destructive → ask) — an approval queued under the anon subject.
        toolCallTurn("host_invoices_delete", { id: "inv_0003" }, "call_del"),
      ],
    });

    const one = anonClient(stack);
    const two = anonClient(stack);

    // --- Client 1 creates an app ------------------------------------------
    const created = await readSse(
      await one.fetch("/threads", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thr_anon_app",
          message: { id: "u1", role: "user", parts: [{ type: "text", text: "Build a greeting card" }] },
        }),
      }),
    );
    expect(created.raw.includes("Created your app.")).toBe(true);
    expect(one.lastMintedCookie()).toBe(true); // first request mints the session
    const oneId = one.id();
    expect(oneId).toMatch(/^[0-9a-f]{32}$/);

    // --- Client 1 parks a destructive approval (second thread, SAME cookie) --
    const parked = await one.fetch("/threads", {
      method: "POST",
      body: JSON.stringify({
        threadId: "thr_anon_del",
        message: { id: "u2", role: "user", parts: [{ type: "text", text: "Delete invoice inv_0003" }] },
      }),
    });
    await readSse(parked);
    expect(one.lastMintedCookie()).toBe(false); // a valid cookie is reused, not re-minted
    expect(one.id()).toBe(oneId); // subject is stable across requests

    // --- Client 1 sees its own threads / app / approval -------------------
    const oneThreads = (await (await one.fetch("/threads")).json()) as Array<{ id: string }>;
    expect(oneThreads.map((thread) => thread.id).sort()).toEqual(["thr_anon_app", "thr_anon_del"]);

    const oneApps = (await (await one.fetch("/apps")).json()) as Array<{ id: string }>;
    expect(oneApps).toHaveLength(1);

    const oneApprovals = (await (await one.fetch("/approvals")).json()) as Array<{ id: string }>;
    expect(oneApprovals).toHaveLength(1);

    // --- Client 2 is a DIFFERENT subject and sees NONE of it --------------
    const twoThreads = (await (await two.fetch("/threads")).json()) as unknown[];
    expect(twoThreads).toEqual([]);
    expect(two.lastMintedCookie()).toBe(true); // client 2 got its own fresh session
    expect(two.id()).not.toBe(oneId); // distinct subjects

    const twoApps = (await (await two.fetch("/apps")).json()) as unknown[];
    expect(twoApps).toEqual([]);

    const twoApprovals = (await (await two.fetch("/approvals")).json()) as unknown[];
    expect(twoApprovals).toEqual([]);

    // --- Ephemeral rows are ordinary disk rows under client 1's subject (02 §4, B3) --
    for (const [table, expected] of [["vendo_threads", 2], ["vendo_apps", 1], ["vendo_approvals", 1]] as const) {
      const rows = await stack.sql<{ subject: string }>(`SELECT subject FROM ${table}`);
      expect(rows, table).toHaveLength(expected);
      for (const row of rows) expect(row.subject, table).toBe(`anonymous_${oneId}`);
    }
  });
});

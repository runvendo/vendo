/** ENG-263 §C — ANONYMOUS→SIGNED-IN AUTO-MERGE through the composed wire.
 *
 * The first authenticated request carrying a valid anonymous-session cookie
 * adopts the session's threads/apps/state into the signed-in subject and
 * retires the cookie. Deliberately NOT migrated: grants and approvals (and
 * connected accounts) — consent doesn't transfer identities.
 *
 * Adversarial coverage:
 *   - an anonymous session cannot be used to STEAL another subject's rows
 *     (colliding ids are skipped, the durable row wins),
 *   - a forged (tampered) cookie merges nothing and is not honored,
 *   - the merge is idempotent under cookie replay.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ADA,
  createStack,
  generationTurn,
  readSse,
  resetFixture,
  textTurn,
  toolCallTurn,
  WIRE_BASE,
  type Stack,
} from "./harness.js";

const CREATE_DIALECT = {
  name: "Anon Merge App",
  description: "A tiny greeting card",
  tree: {
    formatVersion: "vendo-genui/v1",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["greeting"] },
      { id: "greeting", component: "Text", source: "prewired", props: { text: "Hello anon" } },
    ],
  },
};

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

/** A browser-like anonymous client with its own cookie jar (no x-vendo-test-user). */
function anonClient(current: Stack): {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  cookie(): string | undefined;
} {
  let cookie: string | undefined;
  return {
    async fetch(path, init = {}) {
      const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
      const method = (init.method ?? "GET").toUpperCase();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && headers["content-type"] === undefined) {
        headers["content-type"] = "application/json";
      }
      if (cookie !== undefined) headers.cookie = `vendo_anon_session=${cookie}`;
      const response = await fetch(`${current.baseUrl}${WIRE_BASE}${path}`, { ...init, headers });
      const minted = /vendo_anon_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "");
      if (minted && minted[1] !== "") cookie = minted[1];
      return response;
    },
    cookie() {
      return cookie;
    },
  };
}

/** An authenticated wire request that ALSO carries an anonymous cookie. */
async function signedInWithCookie(
  current: Stack,
  path: string,
  anonCookie: string,
  subject = ADA.subject,
): Promise<Response> {
  return fetch(`${current.baseUrl}${WIRE_BASE}${path}`, {
    headers: {
      "x-vendo-test-user": subject,
      cookie: `vendo_anon_session=${anonCookie}`,
    },
  });
}

describe("ENG-263: anonymous→signed-in auto-merge", () => {
  it("adopts threads/apps into the signed-in subject, drops approvals, clears the cookie, idempotently", async () => {
    await resetFixture();
    stack = await createStack({
      turns: [
        toolCallTurn("vendo_apps_create", { prompt: "Build a greeting card" }, "call_app"),
        generationTurn(CREATE_DIALECT),
        textTurn("Created your app.", "t1"),
        // A destructive host tool the composed policy parks → an approval
        // queued under the ANON subject (the consent that must NOT migrate).
        toolCallTurn("host_invoices_delete", { id: "inv_0003" }, "call_del"),
      ],
    });

    const anon = anonClient(stack);

    // --- Anonymous session accrues an app + two threads + one parked approval.
    await readSse(await anon.fetch("/threads", {
      method: "POST",
      body: JSON.stringify({
        threadId: "thr_merge_app",
        message: { id: "u1", role: "user", parts: [{ type: "text", text: "Build a greeting card" }] },
      }),
    }));
    await readSse(await anon.fetch("/threads", {
      method: "POST",
      body: JSON.stringify({
        threadId: "thr_merge_del",
        message: { id: "u2", role: "user", parts: [{ type: "text", text: "Delete invoice inv_0003" }] },
      }),
    }));
    const anonApprovals = (await (await anon.fetch("/approvals")).json()) as unknown[];
    expect(anonApprovals).toHaveLength(1);
    const cookie = anon.cookie();
    expect(cookie).toBeDefined();

    // The anonymous work is on disk under the anon subject (02 §4, kill-list B3).
    const anonThreadRows = await stack.sql<{ subject: string }>("SELECT subject FROM vendo_threads");
    expect(anonThreadRows).toHaveLength(2);
    for (const row of anonThreadRows) expect(row.subject).toMatch(/^anonymous_[0-9a-f]{32}$/);

    // --- First authenticated request carrying the anon cookie merges + clears.
    const merged = await signedInWithCookie(stack, "/threads", cookie!);
    expect(merged.status).toBe(200);
    const setCookie = merged.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("vendo_anon_session=;");
    expect(setCookie).toContain("Max-Age=0");

    // Threads and the app are Ada's now — durable, under her subject.
    const threadIds = ((await merged.json()) as Array<{ id: string }>).map((thread) => thread.id).sort();
    expect(threadIds).toEqual(["thr_merge_app", "thr_merge_del"]);
    const threadRows = await stack.sql<{ id: string; subject: string }>(
      "SELECT id, subject FROM vendo_threads ORDER BY id",
    );
    expect(threadRows).toEqual([
      { id: "thr_merge_app", subject: ADA.subject },
      { id: "thr_merge_del", subject: ADA.subject },
    ]);
    const appRows = await stack.sql<{ subject: string }>("SELECT subject FROM vendo_apps");
    expect(appRows).toEqual([{ subject: ADA.subject }]);

    // Consent did NOT transfer: no approvals under Ada, none on disk at all.
    const adaApprovals = (await (await stack.wireFetch("/approvals", {}, ADA)).json()) as unknown[];
    expect(adaApprovals).toEqual([]);
    expect(await stack.sql("SELECT id FROM vendo_approvals")).toEqual([]);
    expect(await stack.sql("SELECT id FROM vendo_grants")).toEqual([]);

    // The merge is auditable: one kind="principal" anon-merge event under Ada.
    const auditRows = await stack.sql<{ subject: string; event: { detail?: { event?: string; from?: string } } }>(
      "SELECT subject, event FROM vendo_audit WHERE kind = 'principal'",
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.subject).toBe(ADA.subject);
    expect(auditRows[0]?.event.detail?.event).toBe("anon-merge");
    expect(auditRows[0]?.event.detail?.from).toMatch(/^anonymous_[0-9a-f]{32}$/);

    // --- Replay: the same cookie merges nothing more and still clears.
    const replay = await signedInWithCookie(stack, "/threads", cookie!);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as unknown[]).length).toBe(2); // no duplicates
    expect(
      await stack.sql("SELECT id FROM vendo_audit WHERE kind = 'principal'"),
    ).toHaveLength(1); // no second merge event
  });

  it("cannot steal another subject's rows and ignores forged cookies", async () => {
    await resetFixture();
    stack = await createStack({ turns: [textTurn("hi bob", "tb"), textTurn("mallory turn", "tm")] });

    // Bob owns a durable thread.
    await readSse(await stack.wireFetch("/threads", {
      method: "POST",
      body: JSON.stringify({
        threadId: "thr_bobs",
        message: { id: "b1", role: "user", parts: [{ type: "text", text: "hello" }] },
      }),
    }, { kind: "user", subject: "user_bob" }));
    expect(await stack.sql("SELECT subject FROM vendo_threads WHERE id = 'thr_bobs'"))
      .toEqual([{ subject: "user_bob" }]);

    // Mallory's ANONYMOUS session plants a thread with Bob's id (the wire lets
    // clients pick thread ids), then signs in: the merge must not flip Bob's row.
    const mallory = anonClient(stack);
    const planted = await mallory.fetch("/threads", {
      method: "POST",
      body: JSON.stringify({
        threadId: "thr_bobs",
        message: { id: "m1", role: "user", parts: [{ type: "text", text: "mine now" }] },
      }),
    });
    // Whether the wire parks or errors the colliding write, the merge path must
    // stay safe — drive it regardless.
    void planted.body?.cancel();
    const cookie = mallory.cookie();
    if (cookie !== undefined) {
      await signedInWithCookie(stack, "/threads", cookie, "user_mallory");
    }
    expect(await stack.sql("SELECT subject FROM vendo_threads WHERE id = 'thr_bobs'"))
      .toEqual([{ subject: "user_bob" }]); // unmoved

    // A garbage cookie (wrong shape — rejected by the pointer grammar) merges
    // nothing and is NOT cleared — no new merge audit event appears.
    const before = (await stack.sql("SELECT id FROM vendo_audit WHERE kind = 'principal'")).length;
    const forged = `${"a".repeat(32)}.${"b".repeat(64)}`;
    const response = await signedInWithCookie(stack, "/threads", forged);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("Max-Age=0");
    expect(await stack.sql("SELECT id FROM vendo_audit WHERE kind = 'principal'")).toHaveLength(before);
  });
});

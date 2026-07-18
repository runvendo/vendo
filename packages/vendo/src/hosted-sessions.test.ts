import type { Principal } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type CreateVendoConfig, type Vendo } from "./server.js";
import { fakeConsole, type RecordedRequest } from "./hosted-store.test-util.js";

// The spec review's live repro (2026-07-18 fix round): a keyed composition
// with NO explicit store must serve anonymous traffic — ephemeral sessions
// register, adopt, and sweep over the STORE WIRE instead of dying in the
// local engine's dbFor. Local compositions keep the SQL path byte-identical
// (session-lifecycle.test.ts).

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const signedIn: Principal = { kind: "user", subject: "user_signed" };

interface Harness {
  vendo: Vendo;
  console_: ReturnType<typeof fakeConsole>;
  setNow: (value: number) => void;
  signIn: () => void;
  wireCalls: (suffix: string) => RecordedRequest[];
}

/** The demo-accounting-shaped composition: VENDO_API_KEY set, no explicit
 * store, host principal resolver returns null (anonymous visitors). */
function harness(sessions?: CreateVendoConfig["sessions"]): Harness {
  vi.stubEnv("VENDO_API_KEY", "vnd_hosted_key");
  vi.stubEnv("VENDO_CLOUD_URL", "https://cloud-sessions.test");
  const console_ = fakeConsole();
  vi.stubGlobal("fetch", console_.handler as unknown as typeof fetch);
  let now = 0;
  let current: Principal | null = null;
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => current,
    ...(sessions === undefined ? {} : { sessions: { ...sessions, now: () => now } }),
  });
  cleanups.push(async () => { await vendo.store.close(); });
  return {
    vendo,
    console_,
    setNow: (value) => { now = value; },
    signIn: () => { current = signedIn; },
    wireCalls: (suffix) =>
      console_.requests.filter((request) => new URL(request.url).pathname.endsWith(suffix)),
  };
}

const listThreads = (cookie?: string): Request =>
  new Request("https://host.test/api/vendo/threads", {
    headers: cookie === undefined ? {} : { cookie },
  });

const cookieOf = (res: Response): string => {
  const setCookie = res.headers.get("set-cookie");
  if (setCookie === null) throw new Error("no anonymous cookie was minted");
  return setCookie.split(";")[0]!; // name=value
};

describe("hosted store: ephemeral sessions over the wire", () => {
  it("serves an anonymous request keyed with no explicit store — registration rides the wire", async () => {
    const h = harness();
    const response = await h.vendo.handler(listThreads());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);

    // The minted anonymous subject was registered (== touched) on the console,
    // not through the local engine.
    const registered = h.wireCalls("/sessions/register");
    expect(registered).toHaveLength(1);
    const body = registered[0]!.json as { subject: string };
    expect(body.subject).toMatch(/^anonymous_/);
    expect(registered[0]!.authorization).toBe("Bearer vnd_hosted_key");
    expect(h.console_.sessions.has(body.subject)).toBe(true);

    // Touch on every request: a second request re-registers the same subject.
    const again = await h.vendo.handler(listThreads(cookieOf(response)));
    expect(again.status).toBe(200);
    expect(h.wireCalls("/sessions/register")).toHaveLength(2);
    expect((h.wireCalls("/sessions/register")[1]!.json as { subject: string }).subject).toBe(body.subject);
  });

  it("adopts the anonymous session on sign-in through the wire door and retires the cookie", async () => {
    const h = harness();
    const anonResponse = await h.vendo.handler(listThreads());
    const cookie = cookieOf(anonResponse);
    const anonSubject = (h.wireCalls("/sessions/register")[0]!.json as { subject: string }).subject;

    h.signIn();
    const signedResponse = await h.vendo.handler(listThreads(cookie));
    expect(signedResponse.status).toBe(200);

    const adopts = h.wireCalls("/sessions/adopt");
    expect(adopts).toHaveLength(1);
    expect(adopts[0]!.json).toEqual({ from: anonSubject, to: "user_signed" });
    expect(h.console_.sessions.has(anonSubject)).toBe(false);
    // The anon cookie is retired on the response…
    expect(signedResponse.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    // …and the merge landed on the audit trail through the SAME hosted store.
    const auditPuts = h.wireCalls("/records/vendo_audit/put");
    expect(auditPuts.length).toBeGreaterThan(0);
    const detail = (auditPuts[0]!.json as { record: { data: { detail: { event: string; from: string } } } })
      .record.data.detail;
    expect(detail).toMatchObject({ event: "anon-merge", from: anonSubject });
  });

  it("sweeps a stale subject host-side: stale → claim → erase.bySubject over the wire", async () => {
    const h = harness({ ttlMs: 1_000, sweepIntervalMs: 100 });
    h.setNow(0);
    const first = await h.vendo.handler(listThreads());
    expect(first.status).toBe(200);
    const staleSubject = (h.wireCalls("/sessions/register")[0]!.json as { subject: string }).subject;

    // Past the TTL, the next request's amortized sweep runs FIRST and retires
    // the idle session: list stale → claim (mutual exclusion) → the erase
    // cascade, exactly the one-pager's host-driven sequence.
    h.setNow(5_000);
    const second = await h.vendo.handler(listThreads());
    expect(second.status).toBe(200);

    expect(h.wireCalls("/sessions/stale")).toHaveLength(1);
    expect(h.wireCalls("/sessions/stale")[0]!.json).toEqual({ idleMs: 1_000, now: 5_000 });
    expect(h.wireCalls("/sessions/claim")).toHaveLength(1);
    expect(h.wireCalls("/sessions/claim")[0]!.json).toEqual({
      subject: staleSubject,
      idleMs: 1_000,
      now: 5_000,
    });
    expect(h.console_.eraseCalls).toEqual([{ subject: staleSubject }]);
    expect(h.console_.sessions.has(staleSubject)).toBe(false);

    // A live session is never swept: the second visitor's registration (at
    // 5000) survives a third-request sweep inside the TTL.
    h.setNow(5_500);
    await h.vendo.handler(listThreads());
    expect(h.console_.eraseCalls).toHaveLength(1);
  });
});

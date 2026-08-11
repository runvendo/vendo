/**
 * THE ABUSE NEGATIVES for the door's turn credential — written and run RED
 * before the registry existed.
 *
 * The credential is privilege-sensitive: it is the one thing in the system that
 * lets a process-internal caller reach the guard-bound registry without an OAuth
 * grant. Two privilege escalations were caught pre-merge in an earlier wave, so
 * the shape is proven by what it REFUSES first.
 *
 * The whole security argument in one line: a token carries no subject and no
 * permissions — it is a POINTER at "the turn currently in flight on thread T",
 * and everything it can do is what that turn could already do. There is nothing
 * to forge, because nothing about the caller is stated in the token.
 */
import { describe, expect, it } from "vitest";
import type { RunContext, ToolResult, TurnTools } from "@vendoai/core";
import { createTurnCredentials } from "../src/turn-credential.js";

const ctxFor = (subject: string, presence: RunContext["presence"] = "present"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence,
  sessionId: `session_${subject}`,
});

const toolsFor = (marker: string): TurnTools => ({
  async list() {
    return [{ name: marker, title: marker, description: marker, risk: "read" }];
  },
  async call(): Promise<ToolResult> {
    return { status: "ok", output: { marker } };
  },
});

const liveTurn = (subject: string, marker: string, presence?: RunContext["presence"]) => ({
  ctx: ctxFor(subject, presence),
  tools: toolsFor(marker),
});

/**
 * An expired entry is INERT: `resolve()` refuses it whether or not the registry
 * is still holding it, and nothing else in the file can see it (verified against
 * both the pre- and post-fix implementations). "The registry let go of it" has
 * therefore no behavioural surface to assert against, and a retention leak is
 * only visible by looking at the Map the registry builds for itself. This
 * captures that Map from the outside; the product exposes nothing for it.
 */
const probeRegistry = <T>(make: () => T) => {
  const built: Map<string, unknown>[] = [];
  const RealMap = globalThis.Map;
  globalThis.Map = class extends (RealMap as new (...args: ConstructorParameters<typeof Map>) => Map<unknown, unknown>) {
    constructor(...args: ConstructorParameters<typeof Map>) {
      super(...args);
      built.push(this as Map<string, unknown>);
    }
  } as MapConstructor;
  try {
    return {
      registry: make(),
      /** The credential map, identified by a token it holds — so call it once
       *  something has been minted, never by construction order. */
      credentialMap: (token: string) => built.find((map) => map.has(token))!,
    };
  } finally {
    globalThis.Map = RealMap;
  }
};

describe("the door's turn credential — what it refuses", () => {
  it("cannot be minted outside a live turn: there is no context to bind to", async () => {
    const credentials = createTurnCredentials();
    expect(credentials.mint("thr_cold")).toBeUndefined();
  });

  it("resolves to the turn in flight on ITS OWN thread, carrying that turn's ctx", async () => {
    const credentials = createTurnCredentials();
    const release = credentials.publish("thr_a", liveTurn("user_a", "a"));
    const token = credentials.mint("thr_a")!;
    expect(token).toMatch(/^vtk_[0-9a-f]{32,}$/);

    const resolved = await credentials.resolve(token);
    expect(resolved?.ctx.principal.subject).toBe("user_a");
    expect(resolved?.ctx.venue).toBe("chat");
    expect((await resolved!.tools.list())[0]?.name).toBe("a");
    release();
  });

  it("NEGATIVE — cannot reach another thread's context, even when that thread is the only one live", async () => {
    const credentials = createTurnCredentials();
    const releaseA = credentials.publish("thr_a", liveTurn("user_a", "a"));
    const token = credentials.mint("thr_a")!;
    releaseA();

    // Thread B is now the only turn in flight, same host process, same subject.
    const releaseB = credentials.publish("thr_b", liveTurn("user_a", "b"));
    expect(await credentials.resolve(token)).toBeNull();
    releaseB();
  });

  it("NEGATIVE — cannot outlive the turn: between turns the credential resolves to nothing", async () => {
    const credentials = createTurnCredentials();
    const release = credentials.publish("thr_a", liveTurn("user_a", "a"));
    const token = credentials.mint("thr_a")!;
    expect(await credentials.resolve(token)).not.toBeNull();

    release();
    expect(await credentials.resolve(token)).toBeNull();

    // The NEXT turn of the same conversation revives it — that is the point of a
    // conversation-scoped credential a warm box holds across messages.
    const again = credentials.publish("thr_a", liveTurn("user_a", "a2"));
    expect((await (await credentials.resolve(token))!.tools.list())[0]?.name).toBe("a2");
    again();
  });

  it("NEGATIVE — cannot outlive its session: a revoked credential is dead mid-turn", async () => {
    const credentials = createTurnCredentials();
    const release = credentials.publish("thr_a", liveTurn("user_a", "a"));
    const token = credentials.mint("thr_a")!;
    expect(await credentials.resolve(token)).not.toBeNull();

    credentials.revoke(token);
    // The turn is STILL live; the credential is not.
    expect(await credentials.resolve(token)).toBeNull();
    release();
  });

  it("NEGATIVE — a subject cannot be forged, because a thread that changes hands invalidates the credential", async () => {
    const credentials = createTurnCredentials();
    const releaseA = credentials.publish("thr_a", liveTurn("user_a", "a"));
    const token = credentials.mint("thr_a")!;
    releaseA();

    // The same thread id, a DIFFERENT principal. The thread repository already
    // refuses a foreign thread, so this should be unreachable — which is exactly
    // why the credential must not be the thing that trusts it.
    const releaseB = credentials.publish("thr_a", liveTurn("user_intruder", "a"));
    expect(await credentials.resolve(token)).toBeNull();
    releaseB();

    // ...and it stays dead even when the rightful subject comes back: a
    // credential that saw a foreign subject on its thread is burned, not paused.
    const releaseC = credentials.publish("thr_a", liveTurn("user_a", "a"));
    expect(await credentials.resolve(token)).toBeNull();
    releaseC();
  });

  it("NEGATIVE — the burn happens at PUBLISH, so a foreign turn nobody resolved against still kills the credential", async () => {
    const credentials = createTurnCredentials();
    const releaseA = credentials.publish("thr_a", liveTurn("user_a", "a"));
    const token = credentials.mint("thr_a")!;
    releaseA();

    // The intruder's turn comes and goes with NO call arriving in between, so
    // `resolve` never gets a chance to notice. Without a publish-time burn the
    // credential would come back to life the moment the rightful subject's next
    // turn opened — a token that survived a thread changing hands.
    credentials.publish("thr_a", liveTurn("user_intruder", "x"))();
    const releaseC = credentials.publish("thr_a", liveTurn("user_a", "a"));
    expect(await credentials.resolve(token)).toBeNull();
    releaseC();
  });

  it("NEGATIVE — an unregistered or malformed token resolves to nothing", async () => {
    const credentials = createTurnCredentials();
    const release = credentials.publish("thr_a", liveTurn("user_a", "a"));
    for (const invented of ["", "vtk_", "vtk_deadbeef", "bxt_something", "Bearer vtk_x"]) {
      expect(await credentials.resolve(invented), invented).toBeNull();
    }
    release();
  });

  it("NEGATIVE — an idle credential expires even if its conversation never ends", async () => {
    let now = 1_000_000;
    const credentials = createTurnCredentials({ now: () => now, idleMs: 60_000 });
    const release = credentials.publish("thr_a", liveTurn("user_a", "a"));
    const token = credentials.mint("thr_a")!;
    expect(await credentials.resolve(token)).not.toBeNull();

    now += 59_000;
    expect(await credentials.resolve(token)).not.toBeNull();
    now += 2_000;
    expect(await credentials.resolve(token)).toBeNull();
    release();
  });

  it("NEGATIVE — an expired credential is not resurrected by a later turn of its own thread", async () => {
    let now = 1_000_000;
    const credentials = createTurnCredentials({ now: () => now, idleMs: 60_000 });
    const release = credentials.publish("thr_a", liveTurn("user_a", "a"));
    const token = credentials.mint("thr_a")!;
    release();

    // The conversation goes quiet well past the idle budget and then takes
    // another turn, with nothing having resolved the token in between. publish()
    // is the only place that can notice the expiry, because nothing sweeps.
    now += 120_000;
    const again = credentials.publish("thr_a", liveTurn("user_a", "a2"));
    expect(await credentials.resolve(token)).toBeNull();
    again();
  });

  it("an abandoned thread's expired credential is collected by ANY publish, not only its own thread's", async () => {
    let now = 1_000_000;
    const { registry: credentials, credentialMap } = probeRegistry(() =>
      createTurnCredentials({ now: () => now, idleMs: 60_000 }));

    const release = credentials.publish("thr_a", liveTurn("user_a", "a"));
    const token = credentials.mint("thr_a")!;
    const minted = credentialMap(token);
    release();

    // Thread A is ABANDONED: it never takes another turn, and nothing ever
    // resolves its token. Only publish() and resolve() can notice an expiry, so
    // for this entry neither will ever run again.
    now += 120_000;
    for (let i = 0; i < 20; i++) credentials.publish("thr_b", liveTurn("user_b", `b${i}`))();

    expect(minted.has(token)).toBe(false);
    expect(minted.size).toBe(0);
    // Belt and braces: it was never usable while it lingered, either.
    expect(await credentials.resolve(token)).toBeNull();
  });

  it("two mints never collide, and a token is not derivable from the thread it names", () => {
    const credentials = createTurnCredentials();
    const release = credentials.publish("thr_a", liveTurn("user_a", "a"));
    const minted = new Set(Array.from({ length: 64 }, () => credentials.mint("thr_a")!));
    expect(minted.size).toBe(64);
    for (const token of minted) expect(token).not.toContain("thr_a");
    release();
  });

  it("a stale disposer cannot unpublish the turn that replaced it", async () => {
    const credentials = createTurnCredentials();
    const releaseFirst = credentials.publish("thr_a", liveTurn("user_a", "first"));
    const token = credentials.mint("thr_a")!;
    // Turn 2 opens before turn 1's finally block runs (a harness that overlaps).
    const releaseSecond = credentials.publish("thr_a", liveTurn("user_a", "second"));
    releaseFirst();

    const resolved = await credentials.resolve(token);
    expect((await resolved!.tools.list())[0]?.name).toBe("second");
    releaseSecond();
  });
});

import { describe, expect, it } from "vitest";
import {
  agentRunDoorProblem,
  classifySmoke,
  noProgress,
  observedSmokeLatenciesMs,
  readHostToolTraffic,
  smokeBudgetMs,
  smokeReadyMs,
  type SmokeProgress,
} from "./smoke.js";

/** A turn that got as far as streaming AND whose own API answered it — the shape
 *  of every healthy run. */
const alive: SmokeProgress = { doorAnswered: true, turnStarted: true, toolCall: true, hostToolAnswered: true };

describe("smokeReadyMs", () => {
  // Getting to a composer is page load plus hydration, not a model round trip.
  // It has its own budget because a demo whose page never renders is broken NOW,
  // and charging that against the turn budget is how a dead demo took 420s to
  // fail — the real-host probe caught exactly that.
  it("is far shorter than the turn budget, because it is not waiting on a model", () => {
    expect(smokeReadyMs).toBeLessThan(smokeBudgetMs / 4);
    expect(smokeReadyMs).toBeGreaterThanOrEqual(30_000);
  });
});

describe("smokeBudgetMs", () => {
  // The gate this replaces sat at 180_000ms, INSIDE the measured distribution:
  // two of six real runs died on it with demos that were otherwise fine. A
  // budget is only a hard-failure gate if healthy runs cannot reach it, so the
  // measured numbers are pinned here — re-tightening the budget into them has
  // to break this test first.
  it("clears every latency ever measured on a healthy turn, with room to spare", () => {
    const worst = Math.max(...observedSmokeLatenciesMs);
    expect(worst).toBe(182_835);
    expect(smokeBudgetMs).toBeGreaterThanOrEqual(2 * worst);
  });

  it("stays small enough that one attempt cannot eat the pipeline's own cap", () => {
    // defaultCapMs is 40 minutes; a smoke attempt may not be a quarter of it.
    expect(smokeBudgetMs).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});

/**
 * "A hard error from the door" has to mean the door that RUNS THE TURN, and
 * nothing else. The Vendo client talks to many sub-paths under
 * `/api/vendo/<slug>`, and several answer non-2xx in completely healthy
 * operation — `GET /connections` is polled every three seconds and answers 402
 * whenever Cloud connections are not composed, which the UI is explicitly built
 * to survive. A gate that failed on "any 4xx under the route family" would call
 * every healthy demo broken, which is worse than the coin flip it replaced.
 */
describe("agentRunDoorProblem", () => {
  const door = (over: Partial<Parameters<typeof agentRunDoorProblem>[0]> = {}) => agentRunDoorProblem({
    slug: "acme",
    method: "POST",
    pathname: "/api/vendo/acme/threads",
    status: 200,
    ...over,
  });

  it("passes the agent-run door when it answers", () => {
    expect(door()).toBeUndefined();
  });

  // The dead-agent shape: no model provider, or a tools file the runtime cannot
  // parse, both throw on the first actions use — which is this request.
  it("reports the agent-run door answering a server error", () => {
    expect(door({ status: 500 })).toMatch(/500/);
  });

  it("reports the agent-run door refusing the run", () => {
    expect(door({ status: 402 })).toMatch(/402/);
    expect(door({ status: 400 })).toMatch(/400/);
  });

  // The caps guard answering is the guard WORKING. It means this demo's own turn
  // budget is spent or it has expired — a condition about the demo's lifecycle,
  // never evidence that its agent cannot run.
  it("does not call the caps guard's own refusals a broken agent", () => {
    expect(door({ status: 429 })).toBeUndefined();
    expect(door({ status: 410 })).toBeUndefined();
  });

  it("reports a request that never completed at all", () => {
    expect(door({ status: undefined, failure: "net::ERR_CONNECTION_REFUSED" })).toMatch(/ERR_CONNECTION_REFUSED/);
  });

  // Every one of these is a normal, designed non-2xx on a healthy demo.
  it.each([
    ["GET", "/api/vendo/acme/connections", 402, "polled every 3s; 402 whenever Cloud connections are not composed"],
    ["GET", "/api/vendo/acme/connections/catalog", 402, "same Cloud-entitlement condition"],
    ["GET", "/api/vendo/acme/connections/acct_1", 404, "normal during the OAuth poll window"],
    ["GET", "/api/vendo/acme/approvals/ap_1", 404, "the contracted 'expired' signal"],
    ["POST", "/api/vendo/acme/approvals/decide", 409, "a normal multi-surface decide race"],
    ["GET", "/api/vendo/acme/apps/app_1/open", 404, "contracted until the app is servable"],
    ["POST", "/api/vendo/acme/dev/remixable-source", 401, "dev-only probe, ephemeral principal"],
  ])("ignores %s %s → %i (%s)", (method, pathname, status) => {
    expect(agentRunDoorProblem({ slug: "acme", method, pathname, status })).toBeUndefined();
  });

  it("ignores another demo's door entirely", () => {
    expect(agentRunDoorProblem({ slug: "acme", method: "POST", pathname: "/api/vendo/globex/threads", status: 500 })).toBeUndefined();
  });

  // A per-thread sub-path is not the run door: heartbeat deliberately answers
  // 200 for unknown ids, and a thread GET is guarded by a list call.
  it("ignores sub-paths under threads", () => {
    expect(agentRunDoorProblem({ slug: "acme", method: "POST", pathname: "/api/vendo/acme/threads/t1/heartbeat", status: 500 })).toBeUndefined();
  });
});

/**
 * The blind spot this closes. A demo shipped that served HTTP 200, had a
 * pixel-accurate palette and zero console errors — and every agent tool 404'd,
 * so it could not answer a single question. The gate passed because the agent
 * behaved WELL: it retried, diagnosed the 404s and honestly refused rather than
 * fabricating an answer. The turn SETTLED, and settled was all the gate checked.
 *
 * A failed tool call is NOT visible as a stream error: the runtime returns the
 * failure as the tool's OUTPUT so the model can see and report it (see
 * packages/actions registry — a non-2xx becomes `{status:"error",
 * error:{code:"http-error"}}`), which is exactly why "the turn finished" and
 * "the demo works" are different facts.
 */
describe("readHostToolTraffic — did the demo's own API answer its own agent?", () => {
  const hostTools = ["host_listTransactions", "host_refundTransaction"];
  const sse = (...events: unknown[]): string => events.map((event) => `data: ${JSON.stringify(event)}\n`).join("\n");

  it("sees a host tool call that answered", () => {
    const stream = sse(
      { type: "start" },
      { type: "tool-input-start", toolCallId: "c1", toolName: "host_listTransactions" },
      { type: "tool-output-available", toolCallId: "c1", output: { status: "ok", output: { data: [] } } },
      { type: "finish" },
    );
    expect(readHostToolTraffic(stream, hostTools)).toEqual({ answered: true });
  });

  // The numbers failure, byte for byte: the tool ran, the demo's own API 404'd,
  // the runtime handed the model the error as the tool's output, and the turn
  // went on to settle.
  it("sees a host tool call the demo's own API 404'd, and names the path", () => {
    const stream = sse(
      { type: "tool-input-start", toolCallId: "c1", toolName: "host_listTransactions" },
      {
        type: "tool-output-available",
        toolCallId: "c1",
        output: {
          status: "error",
          error: { code: "http-error", message: `GET /api/numbers/api/transactions → 404: {"error":{"message":"Not found"}}` },
        },
      },
    );
    const traffic = readHostToolTraffic(stream, hostTools);
    expect(traffic.answered).toBe(false);
    expect(traffic.problem).toContain("host_listTransactions");
    expect(traffic.problem).toContain("/api/numbers/api/transactions");
    expect(traffic.problem).toContain("404");
  });

  // ONE success is the whole bar. A demo whose first tool errored and whose
  // second answered has proven its API answers its agent.
  it("passes on one success even when another call failed", () => {
    const stream = sse(
      { type: "tool-input-start", toolCallId: "c1", toolName: "host_listTransactions" },
      { type: "tool-output-available", toolCallId: "c1", output: { status: "error", error: { code: "http-error", message: "GET /x → 404: " } } },
      { type: "tool-input-start", toolCallId: "c2", toolName: "host_listTransactions" },
      { type: "tool-output-available", toolCallId: "c2", output: { status: "ok", output: { data: [1] } } },
    );
    expect(readHostToolTraffic(stream, hostTools).answered).toBe(true);
  });

  // Vendo's own tools run inside the runtime and never touch the demo's API, so
  // a turn that only built a view has NOT shown the demo's API answering.
  it("ignores tools that are not the demo's own", () => {
    const stream = sse(
      { type: "tool-input-start", toolCallId: "c1", toolName: "vendo_make" },
      { type: "tool-output-available", toolCallId: "c1", output: { status: "ok", output: { id: "app_1", title: "Spending", status: "ready", say: "It's on your screen." } } },
    );
    expect(readHostToolTraffic(stream, hostTools)).toEqual({ answered: false });
  });

  // A write tool held at the approval gate never reached the API. Counting it
  // would be the same blind spot in a new place.
  it("does not count a call still waiting for approval", () => {
    const stream = sse(
      { type: "tool-input-start", toolCallId: "c1", toolName: "host_refundTransaction" },
      { type: "tool-output-available", toolCallId: "c1", output: { status: "pending-approval", approvalId: "ap_1" } },
    );
    const traffic = readHostToolTraffic(stream, hostTools);
    expect(traffic.answered).toBe(false);
    expect(traffic.problem).toContain("pending-approval");
  });

  it("reads a call that threw instead of returning an outcome", () => {
    const stream = sse(
      { type: "tool-input-start", toolCallId: "c1", toolName: "host_listTransactions" },
      { type: "tool-output-error", toolCallId: "c1", errorText: "fetch failed" },
    );
    expect(readHostToolTraffic(stream, hostTools).problem).toContain("fetch failed");
  });

  // tool-input-start can be missed (a reconnect, a clipped buffer); the same
  // toolName rides tool-input-available.
  it("correlates the tool name from either input event", () => {
    const stream = sse(
      { type: "tool-input-available", toolCallId: "c1", toolName: "host_listTransactions", input: {} },
      { type: "tool-output-available", toolCallId: "c1", output: { status: "ok", output: {} } },
    );
    expect(readHostToolTraffic(stream, hostTools).answered).toBe(true);
  });

  // An output shape this harness does not recognise is NOT reported as a
  // failure: the only way to get an `error` envelope is the failure path, so
  // anything else came back from a 2xx. A protocol change must not invent a
  // broken demo.
  it("treats an unrecognised output envelope as the API having answered", () => {
    const stream = sse(
      { type: "tool-input-start", toolCallId: "c1", toolName: "host_listTransactions" },
      { type: "tool-output-available", toolCallId: "c1", output: { data: [1, 2] } },
    );
    expect(readHostToolTraffic(stream, hostTools).answered).toBe(true);
  });

  it("survives a clipped or non-JSON stream without throwing", () => {
    expect(readHostToolTraffic("", hostTools)).toEqual({ answered: false });
    expect(readHostToolTraffic("data: [DONE]\n\ndata: {\"type\":\"st", hostTools)).toEqual({ answered: false });
    expect(readHostToolTraffic("not a stream at all", hostTools)).toEqual({ answered: false });
  });

  it("reports nothing when the demo declares no host tools", () => {
    const stream = sse({ type: "tool-input-start", toolCallId: "c1", toolName: "host_listTransactions" });
    expect(readHostToolTraffic(stream, [])).toEqual({ answered: false });
  });
});

/**
 * The three-way distinction. Same settled turn, same clock — what separates them
 * is whether the demo's own API ever answered its own agent.
 */
describe("classifySmoke — a demo whose tools are unreachable is its own verdict", () => {
  it("passes a healthy demo", () => {
    expect(classifySmoke({ settled: true, timedOut: false, progress: alive }).verdict).toBe("settled");
  });

  it("fails a demo whose every tool call was 404'd, even though the turn settled", () => {
    const outcome = classifySmoke({
      settled: true,
      timedOut: false,
      progress: {
        doorAnswered: true,
        turnStarted: true,
        toolCall: true,
        hostToolAnswered: false,
        hostToolProblem: `host_listTransactions → GET /api/numbers/api/transactions → 404`,
      },
    });
    expect(outcome.verdict).toBe("tools-unreachable");
    expect(outcome.reason).toContain("404");
    // Reproducible: the wiring is wrong, and a second turn re-proves it at cost.
    expect(outcome.retryable).toBe(false);
  });

  it("keeps a slow-but-healthy turn passing — the tool answered, however late", () => {
    // The turn ran 400s, well past the old 180s deadline, and settled with a
    // successful tool call. Slowness is not this gate's business.
    expect(classifySmoke({ settled: true, timedOut: false, progress: alive }).verdict).toBe("settled");
  });

  it("gives all three outcomes verdicts and messages an operator cannot confuse", () => {
    const healthy = classifySmoke({ settled: true, timedOut: false, progress: alive });
    const unreachable = classifySmoke({
      settled: true,
      timedOut: false,
      progress: { ...alive, hostToolAnswered: false, hostToolProblem: "host_listTransactions → GET /x → 404" },
    });
    const brokenDemo = classifySmoke({ settled: false, timedOut: true, progress: noProgress() });
    const slow = classifySmoke({ settled: false, timedOut: true, progress: { ...alive } });
    expect([healthy.verdict, unreachable.verdict, brokenDemo.verdict, slow.verdict])
      .toEqual(["settled", "tools-unreachable", "broken", "timeout"]);
    expect(unreachable.reason).not.toBe(brokenDemo.reason);
    expect(unreachable.reason).not.toBe(slow.reason);
  });

  // The one case a second attempt can genuinely clear: the model chose not to
  // call a tool. Nothing about the demo is known to be wrong yet.
  it("retries a turn in which the agent never called one of its own tools", () => {
    const outcome = classifySmoke({
      settled: true,
      timedOut: false,
      progress: { doorAnswered: true, turnStarted: true, toolCall: false, hostToolAnswered: false },
    });
    expect(outcome.verdict).toBe("tools-unreachable");
    expect(outcome.reason).toMatch(/never called/i);
    expect(outcome.retryable).toBe(true);
  });

  // The known data-binding gaps must still ship: a demo whose generated view
  // renders the wrong column is stage 5's business, and stage 4 cannot see it.
  it("passes a demo whose API answered even if the turn generated nothing at all", () => {
    const outcome = classifySmoke({
      settled: true,
      timedOut: false,
      progress: { doorAnswered: true, turnStarted: true, toolCall: false, hostToolAnswered: true },
    });
    expect(outcome.verdict).toBe("settled");
  });
});

describe("classifySmoke — a genuinely BROKEN demo fails, and fails fast", () => {
  // The dead-agent shape the gate exists to catch: the page renders, the agent
  // route throws (no model provider, a tools file the runtime cannot parse), and
  // the browser gets a 500 within seconds of the first send.
  it("calls a hard error from the demo's own agent route broken", () => {
    const outcome = classifySmoke({
      settled: false,
      timedOut: false,
      progress: { doorAnswered: true, doorError: "POST /api/vendo/acme → 500", turnStarted: false, toolCall: false, hostToolAnswered: false },
    });
    expect(outcome.verdict).toBe("broken");
    expect(outcome.reason).toContain("500");
  });

  it("calls a turn that surfaced an error broken", () => {
    const outcome = classifySmoke({
      settled: false,
      timedOut: false,
      surfacedError: "Something went wrong and the response didn’t finish.",
      progress: { doorAnswered: true, turnStarted: true, toolCall: false, hostToolAnswered: false },
    });
    expect(outcome.verdict).toBe("broken");
    expect(outcome.reason).toContain("didn’t finish");
  });

  /**
   * Found by running the real thing with an invalid provider key: the demo's
   * Vendo page never rendered a composer at all, so the wait for it burned the
   * WHOLE turn budget and then threw a raw Playwright TimeoutError instead of a
   * verdict. A genuinely broken demo took 420s to fail and reported nothing
   * useful — and widening the budget had made that case worse, not better.
   */
  it("calls a page that never became usable broken, and says which part failed", () => {
    const outcome = classifySmoke({
      settled: false,
      timedOut: false,
      pageUnusable: "no composer appeared within 60000ms",
      progress: noProgress(),
    });
    expect(outcome.verdict).toBe("broken");
    expect(outcome.reason).toContain("composer");
    // Cheap to re-prove: this fails in seconds, so one retry costs nothing.
    expect(outcome.retryable).toBe(true);
  });

  it("prefers the page fault over the generic 'never produced a turn' reason", () => {
    const vague = classifySmoke({ settled: false, timedOut: true, progress: noProgress() });
    const precise = classifySmoke({ settled: false, timedOut: false, pageUnusable: "the composer never armed", progress: noProgress() });
    expect(vague.verdict).toBe("broken");
    expect(precise.verdict).toBe("broken");
    expect(precise.reason).not.toBe(vague.reason);
  });

  // The other dead-agent shape: nothing errors, nothing arrives either. This is
  // the ONE case where the clock is the evidence — and it is still called
  // broken, not slow, because a demo that produced literally nothing in the
  // whole budget has not been shown to work at all.
  it("calls a deadline with no turn and no tool call broken, never merely slow", () => {
    const outcome = classifySmoke({
      settled: false,
      timedOut: true,
      progress: noProgress(),
    });
    expect(outcome.verdict).toBe("broken");
    expect(outcome.reason).toMatch(/never/i);
  });
});

describe("classifySmoke — a SLOW but healthy demo is not called broken", () => {
  it("passes a turn that settled, however long it took", () => {
    expect(classifySmoke({ settled: true, timedOut: false, progress: alive }).verdict).toBe("settled");
  });

  // The distinction that IS the fix. Same wall clock, same deadline; the demo
  // that demonstrably streamed and called a tool is reported as a TIMEOUT, and
  // the one that did nothing is reported as BROKEN. The old gate called both
  // "Timed out after 180000ms waiting for the generated Vendo turn".
  it("separates a slow living agent from a dead one at the very same deadline", () => {
    const slow = classifySmoke({ settled: false, timedOut: true, progress: alive });
    const dead = classifySmoke({ settled: false, timedOut: true, progress: noProgress() });
    expect(slow.verdict).toBe("timeout");
    expect(dead.verdict).toBe("broken");
    expect(slow.verdict).not.toBe(dead.verdict);
  });

  it("counts a streamed turn as life even when no tool call was ever seen", () => {
    // The transcript renders no trace of a SETTLED tool call, so the observer
    // can miss one that really happened; a streamed turn alone is enough.
    const outcome = classifySmoke({
      settled: false,
      timedOut: true,
      progress: { doorAnswered: true, turnStarted: true, toolCall: false, hostToolAnswered: false },
    });
    expect(outcome.verdict).toBe("timeout");
  });

  it("counts a tool call as life even when no assistant article ever attached", () => {
    const outcome = classifySmoke({
      settled: false,
      timedOut: true,
      progress: { doorAnswered: true, turnStarted: false, toolCall: true, hostToolAnswered: false },
    });
    expect(outcome.verdict).toBe("timeout");
  });
});

describe("classifySmoke — what a second attempt can and cannot fix", () => {
  // Run E died here: "Something went wrong and the response didn't finish" at
  // 129s, on a demo that was fine. An external inference failure is not the
  // demo's bug, and it is the one outcome a retry can genuinely clear.
  it("marks an errored turn retryable — that failure came from outside the demo", () => {
    expect(classifySmoke({
      settled: false,
      timedOut: false,
      surfacedError: "Something went wrong and the response didn’t finish.",
      progress: alive,
    }).retryable).toBe(true);
  });

  it("marks a hard door error retryable, because it costs seconds to re-prove", () => {
    expect(classifySmoke({
      settled: false,
      timedOut: false,
      progress: { doorAnswered: true, doorError: "POST /api/vendo/acme → 500", turnStarted: false, toolCall: false, hostToolAnswered: false },
    }).retryable).toBe(true);
  });

  // A retry after a deadline costs another whole budget of wall clock and
  // cannot change what the clock already proved.
  it("never marks a deadline retryable, whichever way it was classified", () => {
    expect(classifySmoke({ settled: false, timedOut: true, progress: alive }).retryable).toBe(false);
    expect(classifySmoke({ settled: false, timedOut: true, progress: noProgress() }).retryable).toBe(false);
  });

  it("never marks a settled turn retryable", () => {
    expect(classifySmoke({ settled: true, timedOut: false, progress: alive }).retryable).toBe(false);
  });
});

describe("classifySmoke — precedence", () => {
  // A door that 500s while the page also shows an alert is ONE fault, and the
  // door is the more specific evidence.
  it("reports the door's own error ahead of the alert the page rendered", () => {
    const outcome = classifySmoke({
      settled: false,
      timedOut: false,
      surfacedError: "the response didn’t finish",
      progress: { doorAnswered: true, doorError: "POST /api/vendo/acme → 500", turnStarted: false, toolCall: false, hostToolAnswered: false },
    });
    expect(outcome.reason).toContain("500");
  });

  // Content is stage 5's business (frozen contract): the classifier is handed
  // liveness signals only, so no verdict can depend on what was generated.
  // `hostToolAnswered` is the fourth of them — whether the demo's API answered
  // is a fact about the wire, not about what came back over it.
  it("carries no content — only liveness signals", () => {
    const outcome = classifySmoke({ settled: true, timedOut: false, progress: alive });
    expect(Object.keys(outcome.progress).sort()).toEqual(["doorAnswered", "hostToolAnswered", "toolCall", "turnStarted"]);
  });
});

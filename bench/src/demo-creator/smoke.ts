/**
 * The smoke turn's verdict: is this demo's agent BROKEN, or just SLOW?
 *
 * Stage 4 proves a generated demo's agent works by driving one real turn. The
 * question that gate has to answer is whether the demo is broken — no tools, a
 * tools file the runtime cannot parse, no model provider — and every one of those
 * is a real bug it has caught. The question it must NOT answer is whether
 * Anthropic was fast today.
 *
 * The gate used to answer only the second question. It was a single 180s
 * wall-clock deadline, and these are the turn latencies measured on this machine
 * against the deployed Cloud posture (see {@link observedSmokeLatenciesMs}):
 *
 *   run 2  globex-orders             89_122ms  settled   (this gate, on the new budget)
 *   run C  contoso-invoices         104_612ms  settled
 *   run E  contoso-licenses         129_058ms  ERRORED ("the response didn't finish")
 *   run D  contoso-reimbursements   135_675ms  settled
 *   run 1  contoso-cards            165_121ms  settled   ← 14.9s under the deadline
 *   run B  contoso-bills           ≥182_835ms  KILLED BY THE DEADLINE
 *
 * The deadline sat inside that distribution, so it was a coin flip: two of six
 * runs died on demos that were otherwise fine, each costing ~18 minutes and ~$4.
 *
 * This module splits the one question into two. The signals that actually mean
 * BROKEN are watched directly and fail in seconds — a hard error from the demo's
 * own agent route, an errored turn — while a turn that is merely slow is allowed
 * to finish inside a budget the measured distribution cannot reach. The clock is
 * evidence of brokenness in exactly one case, and it is a narrow one: a turn that
 * produced nothing at all, no stream and no tool call, for the whole budget.
 */

/** Every smoke-turn latency measured on a real run, in the order observed. The
 *  budget below is derived from these, and a test holds it against them. */
export const observedSmokeLatenciesMs = [89_122, 104_612, 129_058, 135_675, 165_121, 182_835] as const;

/**
 * How long ONE smoke attempt may run.
 *
 * 2.3x the longest latency ever measured (182_835ms, itself a censored lower
 * bound — that run was killed at the old deadline, not finished), and 4.0x the
 * fastest. Against the three completed settles (mean 135.1s, sd 30.3s) it is
 * mean + 9.4sd, so a healthy turn reaching it would be unlike anything yet
 * observed — which is what makes hitting it a finding rather than a coin toss.
 *
 * Bounded from above by the pipeline's own 40-minute cap: the worst observed run
 * (build 604s + assemble's install/manifest/build/boot ~300s + judge ~120s)
 * leaves this much room and no more.
 */
export const smokeBudgetMs = 420_000;

/**
 * How long the demo's page gets to become usable — loaded, hydrated, composer
 * present — BEFORE the turn budget starts.
 *
 * Its own budget because this phase waits on a Next production build and React
 * hydration, not on a model, and a demo whose page never renders is broken right
 * now. Found the hard way: a probe with an invalid provider key never rendered a
 * composer, so the wait for one consumed the whole 420s turn budget and then
 * threw a raw Playwright error instead of a verdict — a genuinely broken demo
 * taking seven minutes to fail, which is the opposite of the point. Widening the
 * turn budget had made that case worse.
 *
 * 60s is roughly 20x what a healthy freshly-booted host takes to paint.
 */
export const smokeReadyMs = 60_000;

/**
 * What the smoke turn observed about the demo's agent while the turn ran.
 * LIVENESS ONLY — never what was generated. The frozen contract puts content in
 * stage 5, so no field here may describe a view, a tool result or any prose.
 */
export interface SmokeProgress {
  /** The demo's own agent route (`/api/vendo/<slug>/…`) answered at least once. */
  doorAnswered: boolean;
  /** That route's first hard error — a >= 400 status or a failed request. */
  doorError?: string;
  /** An assistant turn began streaming: the model produced bytes. */
  turnStarted: boolean;
  /**
   * A tool call was seen in flight.
   *
   * TRUE is proof a tool call happened; FALSE is NOT proof none did. A settled
   * tool call leaves no trace in the transcript at all (only errored ones do),
   * so this can only ever catch calls that were still live when observed — hence
   * it is read as one of two independent signs of life, never as a requirement.
   */
  toolCall: boolean;
}

/** A turn that showed no sign of life whatsoever. */
export function noProgress(): SmokeProgress {
  return { doorAnswered: false, turnStarted: false, toolCall: false };
}

/**
 * Whether a single browser request says the demo's AGENT DOOR is broken — and it
 * is deliberately only ever ONE request: `POST /api/vendo/<slug>/threads`, the
 * call that runs the turn.
 *
 * Scoped this tightly because the Vendo client talks to many sub-paths under the
 * same prefix and several answer non-2xx in perfectly healthy operation:
 * `GET /connections` is POLLED EVERY THREE SECONDS and answers 402 whenever Cloud
 * connections are not composed (the UI is explicitly built to survive that),
 * `GET /connections/:id` 404s throughout the OAuth poll window,
 * `GET /approvals/:id` 404 IS the contracted "expired" signal, and
 * `POST /approvals/decide` 409s on a normal multi-surface race. A gate that fired
 * on "any 4xx under /api/vendo/<slug>" would call healthy demos broken — worse
 * than the coin flip it replaces — and it would do so only on some machines,
 * which is the least debuggable failure there is.
 *
 * The caps guard's own 429 (turns/spend spent) and 410 (expired or killed) are
 * excluded for a different reason: those mean the guard WORKED. They are facts
 * about this demo's lifecycle, never evidence that its agent cannot run.
 */
export function agentRunDoorProblem(request: {
  slug: string;
  method: string;
  pathname: string;
  /** Absent when the request never completed. */
  status?: number;
  /** Set when the request failed at the transport level. */
  failure?: string;
}): string | undefined {
  const isAgentRun = request.method.toUpperCase() === "POST"
    && request.pathname === `/api/vendo/${request.slug}/threads`;
  if (!isAgentRun) return undefined;
  if (request.status === undefined) {
    return `POST ${request.pathname} → ${request.failure ?? "request failed"}`;
  }
  if (request.status < 400) return undefined;
  // The caps guard doing its job, not a broken agent.
  if (request.status === 429 || request.status === 410) return undefined;
  return `POST ${request.pathname} → ${request.status}`;
}

/** The two in-page signs of life, read back after the turn. */
export interface SmokeObserverApi {
  snapshot(): { turnStarted: boolean; toolCall: boolean };
  dispose(): void;
}

declare global {
  interface Window {
    __vendoSmoke?: SmokeObserverApi;
  }
}

/**
 * Watches the thread for the two signs that the demo's agent is alive, and is a
 * MutationObserver rather than a poll for one specific reason: a settled tool
 * call leaves no trace in the transcript, so the only window in which a tool
 * call is visible is while it runs — and a fast one opens and closes between two
 * 300ms polls. The observer sees the mutation itself, so it cannot miss one.
 *
 * Both flags are STICKY. The question is "did this agent ever do anything", and
 * a turn that finishes must not erase the evidence that it ran.
 *
 * STRICTLY SELF-CONTAINED: Playwright serializes this function's SOURCE and
 * evaluates it in the page, where nothing from this module exists. Every selector
 * is therefore a literal inside the body — hoisting one to a module constant
 * reads fine, typechecks fine, passes a jsdom test fine, and throws
 * ReferenceError in the only place that matters.
 */
export function installSmokeObserverInPage(): void {
  const doc = document;
  const view = doc.defaultView ?? window;
  view.__vendoSmoke?.dispose();

  /** An assistant article attaches the moment a turn STARTS streaming. */
  const assistantTurn = 'article[data-role="assistant"]';
  /** The live status ribbon, present only while a tool call is in flight. */
  const toolRibbon = ".fl-ribbon[data-vendo-tool]";

  // Turns already on the page are not this turn's doing: demo:fix re-smokes a
  // demo whose thread may already hold turns, and counting one of those would
  // call a dead agent alive.
  const before = doc.querySelectorAll(assistantTurn).length;
  let turnStarted = false;
  let toolCall = false;

  const scan = (records: MutationRecord[]): void => {
    if (doc.querySelectorAll(assistantTurn).length > before) turnStarted = true;
    if (doc.querySelector(toolRibbon) !== null) toolCall = true;
    // The added nodes themselves, not just the current document: a ribbon that
    // was attached and detached inside one mutation batch is gone by the time
    // this callback runs, and it is exactly the evidence being looked for.
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof view.HTMLElement)) continue;
        if (node.matches(assistantTurn)) turnStarted = true;
        if (node.matches(toolRibbon) || node.querySelector(toolRibbon) !== null) toolCall = true;
      }
    }
  };

  const observer = new view.MutationObserver(scan);
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-vendo-tool", "data-role", "class"] });

  view.__vendoSmoke = {
    snapshot: () => ({ turnStarted, toolCall }),
    dispose: () => observer.disconnect(),
  };
}

/**
 * - `settled` — the turn finished. The gate passes; content is stage 5's.
 * - `broken`  — the demo's agent does not work. The gate fails.
 * - `timeout` — the agent was alive and did not finish in the budget. The gate
 *               still fails (a turn this slow is not demoable), but it is
 *               reported as its own thing so nobody reads it as a broken demo.
 */
export type SmokeVerdict = "settled" | "broken" | "timeout";

export interface SmokeOutcome {
  verdict: SmokeVerdict;
  /** One operator-readable clause. Always set unless the turn settled. */
  reason?: string;
  progress: SmokeProgress;
  /**
   * Whether ONE more attempt could plausibly change this verdict.
   *
   * True only for the outcomes a SIGNAL produced, which are the ones that arrive
   * in seconds and can come from outside the demo (a transient inference failure
   * killed run E at 129s on a demo that was fine). Never true for an outcome the
   * CLOCK produced: that costs another whole budget and re-proves nothing.
   */
  retryable: boolean;
}

/**
 * The whole broken-vs-slow decision, as a pure function of what was observed —
 * so the distinction is pinned by unit tests instead of by a live model run.
 */
export function classifySmoke(observed: {
  /** The turn settled: a new assistant turn arrived and the composer went idle. */
  settled: boolean;
  /** The wait hit its deadline. */
  timedOut: boolean;
  /** The visible error the turn surfaced, if it surfaced one. */
  surfacedError?: string;
  /**
   * The demo's page never got as far as accepting a prompt (no composer, or a
   * Send that never armed). Set instead of running the turn at all.
   */
  pageUnusable?: string;
  progress: SmokeProgress;
}): SmokeOutcome {
  const { progress } = observed;
  // The door first: when the demo's own route answers 500, that IS the fault,
  // and any alert the page went on to render is the same fault seen downstream.
  if (progress.doorError !== undefined) {
    return {
      verdict: "broken",
      reason: `the demo's agent route answered ${progress.doorError} — the generated demo's own door is failing, not the model`,
      progress,
      retryable: true,
    };
  }
  // Before the turn: a demo whose page will not accept a prompt is broken, and
  // saying WHICH part failed is the difference between a diagnosis and a mystery.
  if (observed.pageUnusable !== undefined) {
    return {
      verdict: "broken",
      reason: `the demo's Vendo page never got as far as accepting a prompt — ${observed.pageUnusable}. The page itself is failing (a server component throwing, or the Vendo surface never mounting), so no turn was ever attempted`,
      progress,
      retryable: true,
    };
  }
  if (observed.surfacedError !== undefined) {
    return {
      verdict: "broken",
      reason: `the smoke turn surfaced an error: ${observed.surfacedError}`,
      progress,
      retryable: true,
    };
  }
  if (observed.settled) return { verdict: "settled", progress, retryable: false };
  const alive = progress.turnStarted || progress.toolCall;
  if (!alive) {
    return {
      verdict: "broken",
      reason: "the demo's agent never produced a turn — no stream ever started and no tool call was ever seen, so nothing proves this demo's agent runs at all",
      progress,
      retryable: false,
    };
  }
  return {
    verdict: "timeout",
    reason: "the smoke turn did not finish in its budget, but the demo's agent was demonstrably running (it streamed and/or called a tool) — this is turn latency, not a broken demo",
    progress,
    retryable: false,
  };
}

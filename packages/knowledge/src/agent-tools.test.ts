import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import type {
  Json,
  KnowledgeAdapter,
  KnowledgeContext,
  KnowledgeDoc,
  KnowledgeHit,
  KnowledgeQuery,
  RunContext,
  ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import {
  createKnowledgeTools,
  KNOWLEDGE_VERIFY_TIMEOUT_MS,
  KNOWLEDGE_VERIFY_TURN_BUDGET_MS,
  VENDO_KNOWLEDGE_SEARCH_TOOL,
  type KnowledgeResultEnvelope,
  type KnowledgeVerifier,
  type KnowledgeVerifierInput,
} from "./index.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "u1" },
  venue: "chat",
  presence: "present",
  sessionId: "s1",
};

const docs: KnowledgeDoc[] = [
  {
    id: "doc-transfers",
    kind: "docs",
    visibility: "public",
    title: "Wire transfer limits",
    text: "Maple caps outbound wire transfers at $25,000 per business day. Limits reset at midnight ET.",
    source: "docs/transfers.md",
  },
  {
    id: "glossary-apy",
    kind: "glossary",
    visibility: "public",
    title: "APY",
    text: "APY (annual percentage yield) is the effective annual rate of return accounting for compounding.",
    source: "glossary/apy.md",
  },
];

describe("createKnowledgeTools descriptor (K1 pin)", () => {
  it("exposes exactly the pinned vendo_knowledge_search descriptor", async () => {
    const registry = createKnowledgeTools(memoryKnowledgeAdapter({ docs }));
    const descriptors = await registry.descriptors();
    expect(descriptors).toHaveLength(1);
    const descriptor = descriptors[0]!;
    expect(descriptor.name).toBe(VENDO_KNOWLEDGE_SEARCH_TOOL);
    expect(descriptor.name).toBe("vendo_knowledge_search");
    expect(descriptor.risk).toBe("read");
    const schema = descriptor.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["lookup", "query", "readMore"]);
    expect(schema.required).toEqual(["query"]);
  });
});

describe("vendo_knowledge_search execute (walking skeleton)", () => {
  it("answers a chat query with mapped hits in the pinned envelope", async () => {
    const registry = createKnowledgeTools(memoryKnowledgeAdapter({ docs }));
    const outcome = await registry.execute(
      { id: "call_1", tool: VENDO_KNOWLEDGE_SEARCH_TOOL, args: { query: "wire transfers" } },
      ctx,
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const output = outcome.output as {
      kind: string;
      outcome: string;
      hits: Array<Record<string, unknown>>;
    };
    expect(output.kind).toBe("vendo/knowledge-result@1");
    expect(output.outcome).toBe("answered");
    expect(output.hits).toHaveLength(1);
    expect(output.hits[0]).toMatchObject({
      docId: "doc-transfers",
      title: "Wire transfer limits",
      source: "docs/transfers.md",
      kind: "docs",
      visibility: "public",
    });
    expect(typeof output.hits[0]!["snippet"]).toBe("string");
  });

  it("rejects an unknown tool name with not-found", async () => {
    const registry = createKnowledgeTools(memoryKnowledgeAdapter({ docs }));
    const outcome = await registry.execute({ id: "call_2", tool: "vendo_other", args: {} }, ctx);
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.error.code).toBe("not-found");
  });

  it("rejects a missing query with a validation error", async () => {
    const registry = createKnowledgeTools(memoryKnowledgeAdapter({ docs }));
    const outcome = await registry.execute({ id: "call_3", tool: VENDO_KNOWLEDGE_SEARCH_TOOL, args: {} }, ctx);
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.error.code).toBe("validation");
  });
});

/** Wraps an adapter recording every search invocation, so policy tests can
    assert intent/kinds/ctx without leaving the memory adapter behind. */
function spyAdapter(adapter: KnowledgeAdapter): KnowledgeAdapter & {
  searches: Array<{ query: KnowledgeQuery; ctx: KnowledgeContext }>;
} {
  const searches: Array<{ query: KnowledgeQuery; ctx: KnowledgeContext }> = [];
  return {
    ...adapter,
    searches,
    async search(query, searchCtx) {
      searches.push({ query: structuredClone(query), ctx: structuredClone(searchCtx) });
      return adapter.search(query, searchCtx);
    },
  };
}

async function envelopeOf(outcome: Awaited<ReturnType<ToolRegistry["execute"]>>): Promise<KnowledgeResultEnvelope> {
  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") throw new Error("expected ok outcome");
  const output = outcome.output as unknown as KnowledgeResultEnvelope;
  expect(output.kind).toBe("vendo/knowledge-result@1");
  return output;
}

const search = (registry: ToolRegistry, args: Json, id = "call_t2") =>
  registry.execute({ id, tool: VENDO_KNOWLEDGE_SEARCH_TOOL, args }, ctx);

describe("tool policy: intent + escalation + refusal (T2)", () => {
  it("passes only { principal } as knowledge context — includeInternal is never set", async () => {
    const adapter = spyAdapter(memoryKnowledgeAdapter({ docs }));
    await search(createKnowledgeTools(adapter), { query: "wire transfers" });
    expect(adapter.searches.length).toBeGreaterThan(0);
    for (const record of adapter.searches) {
      expect(record.ctx).toEqual({ principal: { kind: "user", subject: "u1" } });
      expect("includeInternal" in record.ctx).toBe(false);
    }
  });

  it("defaults to chat intent and answers without escalating when hits are strong", async () => {
    const adapter = spyAdapter(memoryKnowledgeAdapter({ docs }));
    const envelope = await envelopeOf(await search(createKnowledgeTools(adapter), { query: "wire transfers" }));
    expect(envelope.outcome).toBe("answered");
    expect(adapter.searches).toHaveLength(1);
    expect(adapter.searches[0]!.query.intent ?? "chat").toBe("chat");
  });

  it("escalates to deep exactly once on weak results, then refuses with insufficient-evidence", async () => {
    const adapter = spyAdapter(memoryKnowledgeAdapter({ docs: [] }));
    const envelope = await envelopeOf(await search(createKnowledgeTools(adapter), { query: "quantum ledgers" }));
    expect(envelope.outcome).toBe("insufficient-evidence");
    expect(envelope.hits).toEqual([]);
    expect(adapter.searches).toHaveLength(2);
    expect(adapter.searches[0]!.query.intent ?? "chat").toBe("chat");
    expect(adapter.searches[1]!.query.intent).toBe("deep");
  });

  it("answers from the deep retry when escalation finds hits", async () => {
    const base = memoryKnowledgeAdapter({ docs });
    const adapter = spyAdapter({
      ...base,
      async search(query, searchCtx) {
        if (query.intent === "deep") return base.search(query, searchCtx);
        return { hits: [] };
      },
    });
    const envelope = await envelopeOf(await search(createKnowledgeTools(adapter), { query: "wire transfers" }));
    expect(envelope.outcome).toBe("answered");
    expect(envelope.hits).toHaveLength(1);
    expect(adapter.searches.map((record) => record.query.intent ?? "chat")).toEqual(["chat", "deep"]);
  });

  it("treats all-scores-below-threshold as weak and includes the weak hits in the refusal", async () => {
    // The memory adapter always scores 1; a threshold above that makes every
    // hit weak, so the policy escalates once and then refuses WITH the hits.
    const adapter = spyAdapter(memoryKnowledgeAdapter({ docs }));
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(adapter, { weakScoreThreshold: 2 }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("insufficient-evidence");
    expect(envelope.hits).toHaveLength(1);
    expect(envelope.hits![0]).toMatchObject({ docId: "doc-transfers" });
    expect(adapter.searches.map((record) => record.query.intent ?? "chat")).toEqual(["chat", "deep"]);
  });

  it("never falsely refuses with the default threshold of 0", async () => {
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(memoryKnowledgeAdapter({ docs })),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("answered");
  });
});

describe("tool policy: schema lookups (T2)", () => {
  it("lookup:true searches with schema intent AND explicit glossary/api kinds", async () => {
    const adapter = spyAdapter(memoryKnowledgeAdapter({ docs }));
    const envelope = await envelopeOf(await search(createKnowledgeTools(adapter), { query: "APY", lookup: true }));
    expect(envelope.outcome).toBe("answered");
    expect(envelope.hits).toHaveLength(1);
    expect(envelope.hits![0]).toMatchObject({ docId: "glossary-apy", kind: "glossary", visibility: "public" });
    expect(adapter.searches).toHaveLength(1);
    expect(adapter.searches[0]!.query.intent).toBe("schema");
    expect(adapter.searches[0]!.query.kinds).toEqual(["glossary", "api"]);
  });

  it("returns an honest not-found on an empty schema result — no fuzzy fallback, no escalation", async () => {
    // "wire transfers" only matches a docs-kind document; the schema lookup's
    // explicit kinds filter excludes it, so the result must be not-found.
    const adapter = spyAdapter(memoryKnowledgeAdapter({ docs }));
    const envelope = await envelopeOf(await search(createKnowledgeTools(adapter), { query: "wire transfers", lookup: true }));
    expect(envelope.outcome).toBe("not-found");
    expect(adapter.searches).toHaveLength(1);
  });
});

describe("tool policy: read-more (T2)", () => {
  it("fetches the full document text for readMore", async () => {
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(memoryKnowledgeAdapter({ docs })),
      { query: "wire transfer limits", readMore: { docId: "doc-transfers" } },
    ));
    expect(envelope.outcome).toBe("answered");
    expect(envelope.text).toContain("Maple caps outbound wire transfers");
    expect(envelope.truncated).not.toBe(true);
  });

  it("hard-trims readMore text to the 4000-char sizing budget", async () => {
    const long: KnowledgeDoc = {
      id: "doc-long",
      kind: "docs",
      visibility: "public",
      title: "Long policy",
      text: "x".repeat(9000),
      source: "docs/long.md",
    };
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(memoryKnowledgeAdapter({ docs: [long] })),
      { query: "long policy", readMore: { docId: "doc-long" } },
    ));
    expect(envelope.outcome).toBe("answered");
    expect(envelope.text!.length).toBeLessThanOrEqual(4000);
    expect(envelope.truncated).toBe(true);
  });

  it("returns not-found for a readMore miss (unknown or non-visible doc)", async () => {
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(memoryKnowledgeAdapter({ docs })),
      { query: "anything", readMore: { docId: "doc-missing" } },
    ));
    expect(envelope.outcome).toBe("not-found");
  });

  it("refuses readMore with a model-readable error when the posture lacks fetch", async () => {
    const base = memoryKnowledgeAdapter({ docs });
    const noFetch: KnowledgeAdapter = {
      posture: { ...base.posture, fetch: false },
      search: base.search,
      status: base.status,
    };
    const outcome = await search(createKnowledgeTools(noFetch), { query: "anything", readMore: { docId: "doc-transfers" } });
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.error.message).toMatch(/read-more is unavailable/i);
  });
});

describe("tool policy: status()-verified refusals (T2, checker round 1)", () => {
  it("maps a healthy-but-empty search with a THROWING status to unavailable — never a silent refusal", async () => {
    // The checker's probe: search resolves fine (zero hits) but the engine's
    // own status check fails. Reporting insufficient-evidence would be the
    // silent-empty trap — the emptiness is unverifiable, so the outage rule
    // wins.
    const base = memoryKnowledgeAdapter({ docs: [] });
    const sick: KnowledgeAdapter = {
      ...base,
      async status() {
        throw new Error("engine status check failed");
      },
    };
    const envelope = await envelopeOf(await search(createKnowledgeTools(sick), { query: "anything" }));
    expect(envelope.outcome).toBe("unavailable");
  });

  it("still refuses honestly when the empty result is status-verified", async () => {
    // Working status() + empty corpus = a TRUE no-coverage refusal.
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(memoryKnowledgeAdapter({ docs: [] })),
      { query: "quantum ledgers" },
    ));
    expect(envelope.outcome).toBe("insufficient-evidence");
  });

  it("maps an empty schema lookup with a THROWING status to unavailable, not not-found", async () => {
    const base = memoryKnowledgeAdapter({ docs });
    const sick: KnowledgeAdapter = {
      ...base,
      async status() {
        throw new Error("engine status check failed");
      },
    };
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(sick),
      { query: "wire transfers", lookup: true },
    ));
    expect(envelope.outcome).toBe("unavailable");
  });

  it("never consults status() when the evidence is strong", async () => {
    const base = memoryKnowledgeAdapter({ docs });
    let statusCalls = 0;
    const adapter: KnowledgeAdapter = {
      ...base,
      async status() {
        statusCalls += 1;
        return base.status();
      },
    };
    const envelope = await envelopeOf(await search(createKnowledgeTools(adapter), { query: "wire transfers" }));
    expect(envelope.outcome).toBe("answered");
    expect(statusCalls).toBe(0);
  });
});

describe("tool policy: engine outage (T2)", () => {
  it("maps a thrown adapter to a loud unavailable outcome — never a silent empty result", async () => {
    const base = memoryKnowledgeAdapter({ docs });
    const broken: KnowledgeAdapter = {
      ...base,
      async search() {
        throw new Error("engine down");
      },
    };
    const envelope = await envelopeOf(await search(createKnowledgeTools(broken), { query: "wire transfers" }));
    expect(envelope.outcome).toBe("unavailable");
    expect(envelope.hits ?? []).toEqual([]);
  });

  it("maps a thrown fetch to unavailable too", async () => {
    const base = memoryKnowledgeAdapter({ docs });
    const broken: KnowledgeAdapter = {
      ...base,
      async fetch() {
        throw new Error("engine down");
      },
    };
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(broken),
      { query: "anything", readMore: { docId: "doc-transfers" } },
    ));
    expect(envelope.outcome).toBe("unavailable");
  });
});

/** ENG-370 — the 60/min per-principal rate breaker at the registry layer.
 * Over-limit is a LOUD "rate-limited" error outcome, never a silent empty
 * result; the rolling window forgets calls older than a minute. */
describe("rate breaker (ENG-370)", () => {
  const at = (subject: string): RunContext => ({ ...ctx, principal: { kind: "user", subject } });

  async function exhaust(registry: ToolRegistry, runCtx: RunContext, calls: number): Promise<void> {
    for (let index = 0; index < calls; index += 1) {
      const outcome = await registry.execute(
        { id: `call_rate_${index}`, tool: VENDO_KNOWLEDGE_SEARCH_TOOL, args: { query: "wire transfers" } },
        runCtx,
      );
      expect(outcome.status).toBe("ok");
    }
  }

  it("answers the 61st call in a minute with a loud rate-limited error", async () => {
    vi.useFakeTimers();
    try {
      const registry = createKnowledgeTools(memoryKnowledgeAdapter({ docs }));
      await exhaust(registry, ctx, 60);
      const tripped = await search(registry, { query: "wire transfers" });
      expect(tripped.status).toBe("error");
      if (tripped.status !== "error") throw new Error("expected error outcome");
      expect(tripped.error.code).toBe("rate-limited");
      expect(tripped.error.message).toContain("rate-limited");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets: after the window rolls past, the same principal searches again", async () => {
    vi.useFakeTimers();
    try {
      const registry = createKnowledgeTools(memoryKnowledgeAdapter({ docs }));
      await exhaust(registry, ctx, 60);
      expect((await search(registry, { query: "wire transfers" })).status).toBe("error");
      vi.advanceTimersByTime(61_000);
      expect((await search(registry, { query: "wire transfers" })).status).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates principals — one user's burst never throttles another", async () => {
    vi.useFakeTimers();
    try {
      const registry = createKnowledgeTools(memoryKnowledgeAdapter({ docs }));
      await exhaust(registry, at("u_burst"), 60);
      expect((await registry.execute(
        { id: "call_rate_other", tool: VENDO_KNOWLEDGE_SEARCH_TOOL, args: { query: "wire transfers" } },
        at("u_burst"),
      )).status).toBe("error");
      expect((await registry.execute(
        { id: "call_rate_calm", tool: VENDO_KNOWLEDGE_SEARCH_TOOL, args: { query: "wire transfers" } },
        at("u_calm"),
      )).status).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is env-tunable via VENDO_KNOWLEDGE_MAX_CALLS_PER_MINUTE, with an explicit option winning", async () => {
    vi.stubEnv("VENDO_KNOWLEDGE_MAX_CALLS_PER_MINUTE", "2");
    try {
      const fromEnv = createKnowledgeTools(memoryKnowledgeAdapter({ docs }));
      await exhaust(fromEnv, ctx, 2);
      expect((await search(fromEnv, { query: "wire transfers" })).status).toBe("error");

      const explicit = createKnowledgeTools(memoryKnowledgeAdapter({ docs }), { maxCallsPerMinute: 4 });
      await exhaust(explicit, at("u_option"), 2);
      expect((await explicit.execute(
        { id: "call_rate_option", tool: VENDO_KNOWLEDGE_SEARCH_TOOL, args: { query: "wire transfers" } },
        at("u_option"),
      )).status).toBe("ok");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/** An engine whose every hit carries `score`, so band placement is exact. The
    same hit set comes back at every intent unless `deepScore` differs — the
    shape of a reranking engine (the cloud calibration measured chat and deep
    as the same score space). */
function scoredAdapter(score: number, deepScore = score): KnowledgeAdapter & { statusCalls: number } {
  let statusCalls = 0;
  const hit = (value: number): KnowledgeHit => ({
    ref: { docId: "doc-transfers", chunkId: "c1", title: "Wire transfer limits" },
    snippet: "Maple caps outbound wire transfers at $25,000 per business day.",
    kind: "docs",
    visibility: "public",
    score: value,
  });
  const adapter = {
    posture: { fetch: false, write: false },
    async search(query: KnowledgeQuery) {
      return { hits: [hit(query.intent === "deep" ? deepScore : score)] };
    },
    async status() {
      statusCalls += 1;
      return { ok: true } as Awaited<ReturnType<KnowledgeAdapter["status"]>>;
    },
  } as KnowledgeAdapter & { statusCalls: number };
  Object.defineProperty(adapter, "statusCalls", { get: () => statusCalls });
  return adapter;
}

/** A verifier that always answers `verdict`, counting its calls. */
function stubVerifier(
  verdict: boolean | undefined,
  gap = "the passages do not cover it",
): KnowledgeVerifier & { calls: KnowledgeVerifierInput[]; budgets: (number | undefined)[] } {
  const calls: KnowledgeVerifierInput[] = [];
  const budgets: (number | undefined)[] = [];
  return {
    calls,
    budgets,
    async verify(input, options) {
      calls.push(input);
      budgets.push(options?.timeoutMs);
      return verdict === undefined ? undefined : { supported: verdict, gap };
    },
  };
}

// MAIN'S REAL DEFAULT. `weakScoreThreshold` defaults to 0 (agent-tools.ts) and
// nothing on main configures it, so "what the host had before the verifier" is
// this, on every engine including Cloud. K14's tests passed 0.7211 and called
// it "today's threshold"; that framing is what hid a real behaviour change,
// so these tests state the default and assert nothing moves it.
const MAIN_DEFAULT_THRESHOLD = 0;

describe("tool policy: the evidence check runs on EVERY hits-returning search (K15 round 1)", () => {
  // The check is not score-gated. K14 ran it only inside a calibrated band and
  // the live run showed the cost: four unanswerable questions per pass scored
  // outside the band, were never checked, and were answered by the threshold.
  it("verifies a HIGH score — the number the old band called safe", async () => {
    const verifier = stubVerifier(false, "the docs cover neither");
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.84), { verifier }),
      { query: "wire transfers" },
    ));
    expect(verifier.calls).toHaveLength(1);
    expect(envelope.outcome).toBe("insufficient-evidence");
  });

  it("verifies a LOW score — the region the old band left to the threshold", async () => {
    // 0.61 sat below K14's band, so it was never checked and main's default
    // threshold answered it. Three of the live run's persistent false answers
    // were exactly this shape.
    const verifier = stubVerifier(false, "adjacent topic only");
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.61), { verifier }),
      { query: "wire transfers" },
    ));
    expect(verifier.calls).toHaveLength(1);
    expect(envelope.outcome).toBe("insufficient-evidence");
  });

  it("verifies an engine that emits NO scores at all", async () => {
    // Nothing to gate on, and nothing needs to be: the check reads passages.
    const verifier = stubVerifier(false, "not covered");
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(memoryKnowledgeAdapter({ docs }), { verifier }),
      { query: "wire transfers" },
    ));
    expect(verifier.calls.length).toBeGreaterThan(0);
    expect(envelope.outcome).toBe("insufficient-evidence");
  });

  it("a supported verdict answers, whatever the score", async () => {
    for (const score of [0.61, 0.75, 0.84]) {
      const verifier = stubVerifier(true, "states the limit");
      const envelope = await envelopeOf(await search(
        createKnowledgeTools(scoredAdapter(score), { verifier }),
        { query: "wire transfers" },
      ));
      expect(envelope.outcome).toBe("answered");
      expect(envelope.unverified).toBeUndefined();
      expect(verifier.calls).toHaveLength(1);
    }
  });

  it("an unsupported verdict becomes the EXISTING insufficient-evidence outcome", async () => {
    const verifier = stubVerifier(false, "the docs cover React, not Vue");
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), { verifier }),
      { query: "how do I mount vendo in vue" },
    ));
    // Under main's default this question is ANSWERED today: the verifier, not
    // a number, is what changes it.
    expect(envelope.outcome).toBe("insufficient-evidence");
    expect(envelope.hits).toHaveLength(1);
    expect(verifier.calls[0]).toMatchObject({ question: "how do I mount vendo in vue" });
    expect(verifier.calls[0]!.passages[0]).toMatchObject({ docId: "doc-transfers", title: "Wire transfer limits" });
  });

  it("carries the verifier's GAP on the refusal, so the agent can say what is missing", async () => {
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), {
        verifier: stubVerifier(false, "the docs cover React, not Vue"),
      }),
      { query: "how do I mount vendo in vue" },
    ));
    expect(envelope.outcome).toBe("insufficient-evidence");
    expect(envelope.message).toBe("the docs cover React, not Vue");
  });

  it("inside the band, a supported verdict answers", async () => {
    const verifier = stubVerifier(true);
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.69), { verifier }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("answered");
    expect(envelope.unverified).toBeUndefined();
    expect(verifier.calls).toHaveLength(1);
  });

  it("verifies at most once per turn when the deep retry returns the same passages", async () => {
    const verifier = stubVerifier(false);
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), { verifier }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("insufficient-evidence");
    expect(verifier.calls).toHaveLength(1);
  });

  it("skips the status() emptiness check when the VERIFIER produced the refusal", async () => {
    const adapter = scoredAdapter(0.75);
    await search(
      createKnowledgeTools(adapter, { verifier: stubVerifier(false) }),
      { query: "wire transfers" },
    );
    expect(adapter.statusCalls).toBe(0);
  });

  it("changes nothing without a verifier", async () => {
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), {}),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("answered");
    expect(envelope.unverified).toBeUndefined();
  });

  it("verifies schema lookups too — every hits-returning search, no carve-out", async () => {
    // Round 2: this row previously pinned ZERO verifier calls on lookups. A
    // glossary hit for the right term but the wrong fact is exactly the
    // near-miss the check exists for.
    const verifier = stubVerifier(false);
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), { verifier }),
      { query: "APY", lookup: true },
    ));
    expect(verifier.calls).toHaveLength(1);
    expect(envelope.outcome).toBe("insufficient-evidence");
    expect(envelope.message).toBe("the passages do not cover it");
  });

  it("a supported lookup answers unmarked; a no-verdict lookup answers MARKED", async () => {
    const supported = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), { verifier: stubVerifier(true) }),
      { query: "APY", lookup: true },
    ));
    expect(supported.outcome).toBe("answered");
    expect(supported.unverified).toBeUndefined();

    const noVerdict = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), { verifier: stubVerifier(undefined) }),
      { query: "APY", lookup: true },
    ));
    expect(noVerdict.outcome).toBe("answered");
    expect(noVerdict.unverified).toBe(true);
  });

  it("a lookup without a verifier is untouched — today's behavior exactly", async () => {
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), {}),
      { query: "APY", lookup: true },
    ));
    expect(envelope.outcome).toBe("answered");
    expect(envelope.unverified).toBeUndefined();
  });
});

describe("the verifier moves no threshold (K15 T2 — the fail-open regression)", () => {
  // The regression this suite exists for: enabling verification ALSO swapped
  // the weak-score threshold from main's 0 to the Cloud bar 0.7211, so scores
  // the verifier never looked at started refusing. Two decisions, independent.
  const outcomeWith = async (score: number, options: Parameters<typeof createKnowledgeTools>[1]) =>
    (await envelopeOf(await search(createKnowledgeTools(scoredAdapter(score), options), { query: "wire transfers" }))).outcome;

  it("leaves the host's threshold exactly where the host set it", async () => {
    // The regression was a MOVED threshold: composing the verifier swapped 0
    // for 0.7211, so scores it never read started refusing. With no verdict to
    // go on, every score must decide exactly as it did before.
    const noVerdict = stubVerifier(undefined);
    expect(await outcomeWith(0.61, { weakScoreThreshold: MAIN_DEFAULT_THRESHOLD })).toBe("answered");
    expect(await outcomeWith(0.61, { verifier: noVerdict })).toBe("answered");
    expect(await outcomeWith(0.61, { weakScoreThreshold: 0.7211 })).toBe("insufficient-evidence");
    expect(await outcomeWith(0.61, { weakScoreThreshold: 0.7211, verifier: noVerdict }))
      .toBe("insufficient-evidence");
  });

  it("when there IS a verdict, the verdict is the arbiter — in both directions", async () => {
    // Deliberate and spec-stated ("a score may never be the final arbiter of
    // whether we know something"). The check adds refusals the threshold would
    // not have made, and rescues answers it would have refused. What it never
    // does is rewrite the threshold for the cases it did not read.
    expect(await outcomeWith(0.84, { verifier: stubVerifier(false) })).toBe("insufficient-evidence");
    expect(await outcomeWith(0.61, { weakScoreThreshold: 0.7211, verifier: stubVerifier(true) }))
      .toBe("answered");
  });

  it("a verifier that times out cannot turn an answer into a refusal", async () => {
    // Under K14's coupling a no-verdict at 0.69 refused, because enabling the
    // verifier had moved the threshold to 0.7211. It must answer, marked.
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.69), { verifier: stubVerifier(undefined) }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("answered");
    expect(envelope.unverified).toBe(true);
  });
});

describe("fail open BUT MARKED (K15 T2)", () => {
  it("marks an answer the verifier could not check", async () => {
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), { verifier: stubVerifier(undefined) }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("answered");
    expect(envelope.unverified).toBe(true);
  });

  it("marks a refusal the verifier could not check either", async () => {
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), {
        weakScoreThreshold: 0.7835,
        verifier: stubVerifier(undefined),
      }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("insufficient-evidence");
    expect(envelope.unverified).toBe(true);
  });

  it("does NOT mark a host that never composed a verifier — the flag means 'could not check'", async () => {
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), {}),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("answered");
    expect(envelope.unverified).toBeUndefined();
  });

  it("does not mark an outcome the verifier decided", async () => {
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), { verifier: stubVerifier(false) }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("insufficient-evidence");
    expect(envelope.unverified).toBeUndefined();
  });

  it("stays marked for the whole turn once a verification is lost", async () => {
    // Chat is in-band and unverifiable; deep returns DIFFERENT passages the
    // verifier accepts. The answer is still one the tool could not fully
    // check, so the mark survives.
    const verifier: KnowledgeVerifier = {
      async verify(input) {
        return input.passages[0]?.snippet.includes("deep")
          ? { supported: true, gap: "the deep passages cover it" }
          : undefined;
      },
    };
    const adapter = twoIntentAdapter(
      { score: 0.75, snippet: "chat passage" },
      { score: 0.75, snippet: "deep passage" },
    );
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(adapter, { verifier }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("answered");
    expect(envelope.unverified).toBe(true);
  });
});

describe("the per-TURN verification budget (K15 T3)", () => {
  it("gives the FIRST verification the whole turn budget", async () => {
    const verifier = stubVerifier(true);
    await search(
      createKnowledgeTools(scoredAdapter(0.75), { verifier, verifyTurnBudgetMs: 4321 }),
      { query: "wire transfers" },
    );
    expect(verifier.budgets).toEqual([4321]);
  });

  it("gives the deep retry only what the chat verification left", async () => {
    const adapter = twoIntentAdapter(
      { score: 0.75, snippet: "chat passage" },
      { score: 0.75, snippet: "deep passage" },
    );
    const budgets: (number | undefined)[] = [];
    const verifier: KnowledgeVerifier = {
      async verify(input, options) {
        budgets.push(options?.timeoutMs);
        // The first (chat) verification burns most of the turn's budget.
        if (input.passages[0]?.snippet.includes("chat")) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { supported: false, gap: "not covered" };
        }
        return { supported: false, gap: "not covered either" };
      },
    };
    await search(
      createKnowledgeTools(adapter, { verifier, verifyTurnBudgetMs: 2000 }),
      { query: "wire transfers" },
    );
    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toBe(2000);
    expect(budgets[1]!).toBeLessThanOrEqual(2000 - 300);
  });

  it("spends nothing on a second verification when the budget is gone, and marks the turn", async () => {
    const adapter = twoIntentAdapter(
      { score: 0.75, snippet: "chat passage" },
      { score: 0.75, snippet: "deep passage" },
    );
    let calls = 0;
    const verifier: KnowledgeVerifier = {
      async verify() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { supported: false, gap: "not covered" };
      },
    };
    // 400ms of budget, 300ms spent on the chat half: the 100ms left is below
    // the floor where a model call could plausibly answer, so the deep half
    // spends nothing at all.
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(adapter, { verifier, verifyTurnBudgetMs: 400 }),
      { query: "wire transfers" },
    ));
    expect(calls).toBe(1);
    // The deep passages are DIFFERENT text, and nothing checked them: the
    // pre-verifier outcome (main's threshold answers anything with hits)
    // stands, marked — never a refusal manufactured by a missing verdict.
    expect(envelope.outcome).toBe("answered");
    expect(envelope.unverified).toBe(true);
  });

  it("defaults the turn budget to the per-call cap, so one turn cannot cost two", () => {
    expect(KNOWLEDGE_VERIFY_TURN_BUDGET_MS).toBe(KNOWLEDGE_VERIFY_TIMEOUT_MS);
  });
});

/** An engine whose chat and deep intents return DIFFERENT passages — the shape
    that makes a turn verify twice. */
function twoIntentAdapter(
  chat: { score: number; snippet: string },
  deep: { score: number; snippet: string },
): KnowledgeAdapter {
  const hit = (of: { score: number; snippet: string }, docId: string): KnowledgeHit => ({
    ref: { docId, chunkId: "c1", title: "Wire transfer limits" },
    snippet: of.snippet,
    kind: "docs",
    visibility: "public",
    score: of.score,
  });
  return {
    posture: { fetch: false, write: false },
    async search(query: KnowledgeQuery) {
      return query.intent === "deep"
        ? { hits: [hit(deep, "doc-deep")] }
        : { hits: [hit(chat, "doc-chat")] };
    },
    async status() {
      return { ok: true } as Awaited<ReturnType<KnowledgeAdapter["status"]>>;
    },
  } as KnowledgeAdapter;
}

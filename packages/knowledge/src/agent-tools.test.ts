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
function stubVerifier(verdict: boolean | undefined): KnowledgeVerifier & { calls: KnowledgeVerifierInput[] } {
  const calls: KnowledgeVerifierInput[] = [];
  return {
    calls,
    async supported(input) {
      calls.push(input);
      return verdict;
    },
  };
}

// The committed cloud calibration (docs/eval/knowledge/bands/agentset.json).
const BAND = { low: 0.6735, high: 0.7835 };
const BAR = 0.7211;

describe("tool policy: the verification band (K14 T3)", () => {
  it("answers above the band without spending a verification", async () => {
    const verifier = stubVerifier(false);
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.84), { weakScoreThreshold: BAR, verifyBand: BAND, verifier }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("answered");
    expect(verifier.calls).toHaveLength(0);
  });

  it("refuses below the band without spending a verification", async () => {
    const verifier = stubVerifier(true);
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.61), { weakScoreThreshold: BAR, verifyBand: BAND, verifier }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("insufficient-evidence");
    expect(verifier.calls).toHaveLength(0);
  });

  it("inside the band, an unsupported verdict becomes the EXISTING insufficient-evidence outcome", async () => {
    const verifier = stubVerifier(false);
    const adapter = scoredAdapter(0.75);
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(adapter, { weakScoreThreshold: BAR, verifyBand: BAND, verifier }),
      { query: "how do I mount vendo in vue" },
    ));
    // The score clears the shipped bar, so today this question is ANSWERED.
    expect(envelope.outcome).toBe("insufficient-evidence");
    expect(envelope.hits).toHaveLength(1);
    expect(verifier.calls[0]).toMatchObject({ question: "how do I mount vendo in vue" });
    expect(verifier.calls[0]!.passages[0]).toMatchObject({ docId: "doc-transfers", title: "Wire transfer limits" });
  });

  it("inside the band, a supported verdict answers a score the shipped bar would have refused", async () => {
    const verifier = stubVerifier(true);
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.69), { weakScoreThreshold: BAR, verifyBand: BAND, verifier }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("answered");
    expect(verifier.calls).toHaveLength(1);
  });

  it("verifies at most once per turn when the deep retry returns the same passages", async () => {
    const verifier = stubVerifier(false);
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), { weakScoreThreshold: BAR, verifyBand: BAND, verifier }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("insufficient-evidence");
    expect(verifier.calls).toHaveLength(1);
  });

  it("skips the status() emptiness check when the VERIFIER produced the refusal", async () => {
    const adapter = scoredAdapter(0.75);
    await search(
      createKnowledgeTools(adapter, { weakScoreThreshold: BAR, verifyBand: BAND, verifier: stubVerifier(false) }),
      { query: "wire transfers" },
    );
    expect(adapter.statusCalls).toBe(0);
  });

  it("fails OPEN to the shipped threshold when the verifier gives no verdict", async () => {
    // No verdict on a score ABOVE the bar → today's answer.
    const above = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), { weakScoreThreshold: BAR, verifyBand: BAND, verifier: stubVerifier(undefined) }),
      { query: "wire transfers" },
    ));
    expect(above.outcome).toBe("answered");
    // No verdict on a score BELOW the bar → today's refusal.
    const below = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.69), { weakScoreThreshold: BAR, verifyBand: BAND, verifier: stubVerifier(undefined) }),
      { query: "wire transfers" },
    ));
    expect(below.outcome).toBe("insufficient-evidence");
  });

  it("changes nothing without a verifier: the band alone is inert", async () => {
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), { weakScoreThreshold: BAR, verifyBand: BAND }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("answered");
  });

  it("changes nothing without a band: a verifier alone is never consulted", async () => {
    const verifier = stubVerifier(false);
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(scoredAdapter(0.75), { weakScoreThreshold: BAR, verifier }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("answered");
    expect(verifier.calls).toHaveLength(0);
  });

  it("never consults the verifier on an engine that emits no scores", async () => {
    const verifier = stubVerifier(false);
    const envelope = await envelopeOf(await search(
      createKnowledgeTools(memoryKnowledgeAdapter({ docs }), { verifyBand: BAND, verifier }),
      { query: "wire transfers" },
    ));
    expect(envelope.outcome).toBe("answered");
    expect(verifier.calls).toHaveLength(0);
  });

  it("never consults the verifier on a schema lookup — a different score space", async () => {
    const verifier = stubVerifier(false);
    await search(
      createKnowledgeTools(scoredAdapter(0.75), { weakScoreThreshold: BAR, verifyBand: BAND, verifier }),
      { query: "APY", lookup: true },
    );
    expect(verifier.calls).toHaveLength(0);
  });
});
